"""Weekly owner reports: best run vs baseline for every non-club store, as JSON and PDF.

Per store (runs/{best}/reports/{storeId}.json, contract StoreReport):
  changes     the baseline -> best config diff as contract Suggestions. May be empty: then no
              change is recommended and the impact is 0.
  impact      measured store visits and kWh as fractions; gbpPerWeek = energy GBP saved per week
              (positive = saving).
  confidence  from extra-seed checks: baseline and best configs are re-simulated on extra seeds
              (sim.runner.evaluate). The store's objective delta must keep its sign across seeds:
              high when |mean| > 2 std over 3+ seeds, medium when the sign holds, low otherwise or
              when the check cannot run. Calibration caps it (CALIBRATION_EVAL below): without a
              measured calibration error it is at most medium.
  evidence    a sim replay link plus the sources cited by the processed data files (fallback
              sources labelled as such).
  pdfUrl      /files/reports/{run}/{storeId}.pdf, written with fpdf2.

The short "why" paragraph is template text offline. Online, settings.REPORT_MODEL writes it with
citations over plain-text source documents (citations cannot be combined with structured
outputs, so this is a plain-text call); the response cache is used, and the PDF is uploaded with
the Files API. Wording, citations and the file id go to reports/{storeId}.meta.json.
"""

from __future__ import annotations

import hashlib
import os
import statistics
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

import anthropic
from fpdf import FPDF
from fpdf.enums import XPos, YPos

from backend import cache, economics, llm, settings, store
from backend.agents import prompts, rundata
from backend.agents.changes import config_diff, make_suggestion
from backend.agents.objective import NET_VALUE, fraction, gain, per_store, store_value
from backend.agents.wording import change_label, signed_pct
from backend.contract import (
    DAYS,
    Confidence,
    Impact,
    MapStore,
    Source,
    StoreKpis,
    StoreReport,
    Suggestion,
)
from backend.schemas import CalibrationFile, DemandFile, EnergyFile, PersonasFile
from backend.sim import runner

AGENT = "report"
EXTRA_SEED_OFFSETS = (1, 2)
REPLAY_DAY = 5  # Friday: a club night
WEEKS_PER_RUN = DAYS / 7
MAX_EVIDENCE = 6
CONFIDENCE_RANK: dict[str, int] = {"low": 0, "medium": 1, "high": 2}

# Written by backend/sim/calibrate.py. Read keys:
#   "measuredCount": int      venues with measured Popular Times (placeholder shapes never count)
#   "meanError": float | None mean absolute error of peak-normalised hourly shapes over measured
#                             venues (0 = identical, 1 = opposite); None when nothing is measured
CALIBRATION_EVAL = "calibration_eval.json"
CALIBRATION_HIGH_MAX_ERROR = 0.15  # above this, confidence is at most medium
CALIBRATION_MEDIUM_MAX_ERROR = 0.35  # above this, confidence is at most low

PROCESSED_EVIDENCE = ("demand.json", "energy.json", "calibration.json", "personas.json", "map.json")


@dataclass
class Document:
    """A plain-text source document for the cited wording, paired with its evidence link."""

    title: str
    text: str
    source: Source


def seed_confidence(deltas: list[float]) -> Confidence:
    """Confidence from one store's objective deltas across seeds (see module docstring)."""
    if all(abs(d) < 1e-9 for d in deltas):
        return "high"
    if not (all(d > 0 for d in deltas) or all(d < 0 for d in deltas)):
        return "low"
    if len(deltas) >= 3 and abs(statistics.fmean(deltas)) > 2 * statistics.stdev(deltas):
        return "high"
    return "medium"


def calibration_cap() -> tuple[Confidence, str]:
    """The highest confidence the sim's calibration supports, and why."""
    data = store.read_json(settings.PROCESSED_DIR / CALIBRATION_EVAL)
    if not data:
        return "medium", "sim not calibrated yet"
    error = data.get("meanError")
    if not data.get("measuredCount") or error is None:
        return "medium", "calibration targets are placeholders, not measured"
    label = f"calibration error {float(error):.0%} over {data['measuredCount']} venues"
    if error <= CALIBRATION_HIGH_MAX_ERROR:
        return "high", label
    if error <= CALIBRATION_MEDIUM_MAX_ERROR:
        return "medium", label
    return "low", label


def _capped(confidence: Confidence, cap: Confidence) -> Confidence:
    return confidence if CONFIDENCE_RANK[confidence] <= CONFIDENCE_RANK[cap] else cap


def seed_deltas(
    base: rundata.RunFiles,
    best: rundata.RunFiles,
    store_ids: list[str],
    *,
    objective: str | None = None,
) -> dict[str, list[float]] | None:
    """Per store: objective delta best vs baseline on the run's seed plus EXTRA_SEED_OFFSETS.

    `objective` is the training session's (default settings.OBJECTIVE). None when the extra
    simulations cannot run (logged); confidence then falls to low.
    """
    objective = per_store(objective or settings.OBJECTIVE)
    types = rundata.store_types(store.load_map()) if objective == NET_VALUE else {}
    price = economics.area_price_gbp_per_kwh() if objective == NET_VALUE else 0.0

    def delta(sid: str, after: StoreKpis, before: StoreKpis) -> float:
        kind = types.get(sid)
        return gain(
            store_value(after, objective, store_type=kind, price=price),
            store_value(before, objective, store_type=kind, price=price),
            objective,
        )

    deltas = {sid: [delta(sid, best.stores[sid].kpis, base.stores[sid].kpis)] for sid in store_ids}
    seed = best.config.seed
    try:
        for offset in EXTRA_SEED_OFFSETS:
            on_base = runner.evaluate(base.config.stores, seed + offset)
            on_best = runner.evaluate(best.config.stores, seed + offset)
            for sid in store_ids:
                if sid in on_base.stores and sid in on_best.stores:
                    deltas[sid].append(
                        delta(sid, on_best.stores[sid].kpis, on_base.stores[sid].kpis)
                    )
    except Exception as e:  # NotImplementedError before the sim lands, or a failing sim
        llm.log_event(
            best.run, {"agent": AGENT, "type": "seed_check_unavailable", "error": repr(e)}
        )
        return None
    return deltas


def _applied_chain(best_run: int, baseline_run: int) -> list[Suggestion]:
    """The changes applied on the way from the baseline to the best run, oldest first."""
    chain: list[Suggestion] = []
    run: int | None = best_run
    seen: set[int] = set()
    while run is not None and run != baseline_run and run not in seen:
        seen.add(run)
        config = rundata.load_config(run)
        chain = [Suggestion.model_validate(c) for c in config.appliedChanges] + chain
        run = config.parentRun
    return chain


def _impact(sid: str, base: rundata.RunFiles, best: rundata.RunFiles) -> Impact:
    before, after = base.stores[sid].kpis, best.stores[sid].kpis
    saved = base.stats[sid].energyCostGbp - best.stats[sid].energyCostGbp
    return Impact(
        visits=round(fraction(after.visits - before.visits, before.visits), 4),
        kwh=round(fraction(after.kwh - before.kwh, before.kwh), 4),
        gbpPerWeek=round(saved / WEEKS_PER_RUN, 2),
    )


def report_changes(
    sid: str,
    base: rundata.RunFiles,
    best: rundata.RunFiles,
    chain: list[Suggestion],
    impact: Impact,
    confidence: Confidence,
) -> list[Suggestion]:
    """The baseline -> best diff for one store as Suggestions whose deltas add up to the measured
    store impact.

    A diff item can be the sum of several applied steps (close 23:00 -> 03:00 -> 04:00). Each
    item's estimate is the sum of the estimates of the steps that built it; the measured impact is
    then shared out in proportion to those estimates (evenly when they cannot be used).
    """
    items = config_diff(base.config.stores[sid], best.config.stores[sid])
    applied = [s for s in chain if s.storeId == sid]
    steps = [
        [
            s
            for s in applied
            if s.field == item["field"]
            and (item["hours"] is None or set(item["hours"]) & set(s.hours or []))
        ]
        for item in items
    ]
    estimates = [
        (sum(s.expectedDelta.visits for s in group), sum(s.expectedDelta.kwh for s in group))
        for group in steps
    ]
    visits = _share(impact.visits, [e[0] for e in estimates])
    kwh = _share(impact.kwh, [e[1] for e in estimates])
    changes = []
    for index, item in enumerate(items):
        reasons = [s.reason for s in steps[index] if s.reason]
        changes.append(
            make_suggestion(
                sid,
                item["field"],
                item["from"],
                item["to"],
                hours=item["hours"],
                visits=visits[index],
                kwh=kwh[index],
                confidence=confidence,
                reason=reasons[-1] if reasons else "Measured in the sim replay.",
            )
        )
    return changes


def _share(measured: float, estimates: list[float]) -> list[float]:
    """Split a measured total across items in proportion to their estimates."""
    total = sum(estimates)
    if len(estimates) == 1 or total == 0 or (total > 0) != (measured > 0):
        return [measured / len(estimates)] * len(estimates)
    return [measured * e / total for e in estimates]


# --- evidence and source documents -------------------------------------------------------------


def _processed(name: str) -> dict | None:
    data = store.read_json(settings.PROCESSED_DIR / name)
    return data if isinstance(data, dict) else None


def _sources_of(data: dict) -> list[Source]:
    sources = [Source.model_validate(s) for s in data.get("sources", [])]
    if data.get("fallback"):
        sources = [
            s.model_copy(update={"label": f"{s.label} (fallback defaults)"}) for s in sources
        ]
    return sources


def _replay_document(
    sid: str, ms: MapStore, base: rundata.RunFiles, best: rundata.RunFiles
) -> Document:
    before, after = base.config.stores[sid], best.config.stores[sid]
    b_res, a_res = base.stores[sid], best.stores[sid]
    b_stats, a_stats = base.stats[sid], best.stats[sid]
    lines = [
        f"Simulated 14 days of Shoreditch for {ms.name} ({ms.type}), same seed in both runs.",
        f"Baseline run {base.run}: open {before.open}-{before.close}; lighting by hour "
        f"{','.join(before.lighting)}.",
        f"Best run {best.run}: open {after.open}-{after.close}; lighting by hour "
        f"{','.join(after.lighting)}.",
        f"Visits over 14 days: {b_res.kpis.visits} baseline, {a_res.kpis.visits} best.",
        f"Energy over 14 days: {b_res.kpis.kwh:.0f} kWh baseline, {a_res.kpis.kwh:.0f} kWh best.",
        f"Energy cost over 14 days: GBP {b_stats.energyCostGbp:.2f} baseline, "
        f"GBP {a_stats.energyCostGbp:.2f} best.",
        "People per day who found the store shut, by hour (baseline): "
        + ",".join(f"{v:.1f}" for v in b_stats.foundClosedByHour),
        "Visits per day by hour (best run): " + ",".join(f"{v:.1f}" for v in a_res.visitsByHour),
    ]
    source = Source(
        label=f"Sim replay, run {best.run}", url=f"/api/runs/{best.run}/days/{REPLAY_DAY}"
    )
    return Document(title=source.label, text="\n".join(lines), source=source)


def _area_documents(ms: MapStore) -> list[Document]:
    """One document per processed data file that exists, titled with its first source."""
    builders = {
        "demand.json": _demand_text,
        "energy.json": lambda data: _energy_text(data, ms),
        "calibration.json": _calibration_text,
        "personas.json": _personas_text,
    }
    documents = []
    for name in PROCESSED_EVIDENCE:
        data = _processed(name)
        if data is None or name not in builders:
            continue
        sources = _sources_of(data)
        if not sources:
            continue
        try:
            text = builders[name](data)
        except (ValueError, KeyError):
            continue
        documents.append(Document(title=sources[0].label, text=text, source=sources[0]))
    return documents


def _demand_text(data: dict) -> str:
    demand = DemandFile.model_validate(data)
    lines = [
        f"Club night: {c.clubId} on {', '.join(c.days)} from {c.open} to {c.close}, "
        f"about {c.capacity} people inside at peak."
        for c in demand.clubNights
    ]
    lines.append(f"Regular visitors pool: {demand.returningPoolSize} people.")
    return "\n".join(lines)


def _energy_text(data: dict, ms: MapStore) -> str:
    energy = EnergyFile.model_validate(data)
    return "\n".join(
        [
            f"Open-hour energy benchmark for a {ms.type}: "
            f"{energy.kwhPerM2PerOpenHour[ms.type]} kWh per m2 per hour.",
            f"Lighting load: off {energy.lightingKw['off']} kW, low {energy.lightingKw['low']} kW, "
            f"high {energy.lightingKw['high']} kW.",
            "Electricity price by hour (GBP/kWh): "
            + ",".join(f"{p:.2f}" for p in energy.priceGbpPerKwh),
            "Grid carbon by hour (g/kWh): " + ",".join(f"{c:.0f}" for c in energy.carbonGPerKwh),
        ]
    )


def _calibration_text(data: dict) -> str:
    calibration = CalibrationFile.model_validate(data)
    return "\n".join(
        f"Busyness reference for {v.name} ({v.type}): "
        + ("measured Popular Times" if v.measured else "placeholder shape, not measured")
        for v in calibration.venues
    )


def _personas_text(data: dict) -> str:
    personas = PersonasFile.model_validate(data)
    return "\n".join(
        f"Visitor archetype {p.label}: {p.share:.0%} of arrivals, regulars {p.returningProb:.0%}."
        for p in personas.personas
    )


def _unique(documents: list[Document]) -> list[Document]:
    """One document per source, so citation [n] is always evidence item n."""
    out: list[Document] = []
    for document in documents:
        key = (document.source.label, document.source.url)
        if all((d.source.label, d.source.url) != key for d in out):
            out.append(document)
    return out


def _evidence(documents: list[Document], ms: MapStore) -> list[Source]:
    evidence = [d.source for d in documents]
    calibration = _processed("calibration.json")
    if calibration:
        for venue in CalibrationFile.model_validate(calibration).venues:
            if venue.storeId == ms.id and venue.measured and venue.source is not None:
                evidence.append(venue.source)
    for name in PROCESSED_EVIDENCE:
        data = _processed(name)
        if data:
            evidence.extend(_sources_of(data))
    unique: list[Source] = []
    for source in evidence:
        if all((s.label, s.url) != (source.label, source.url) for s in unique):
            unique.append(source)
    return unique[:MAX_EVIDENCE]


# --- wording -------------------------------------------------------------------------------------


def template_wording(
    name: str, changes: list[Suggestion], impact: Impact, confidence: str, basis: str
) -> str:
    if not changes:
        return (
            f"No change recommended for {name} this week: your current hours and lighting did "
            "best in 14 simulated days. Simulated, not guaranteed."
        )
    money = (
        f"about £{impact.gbpPerWeek:.0f} a week saved on energy"
        if impact.gbpPerWeek >= 0
        else f"about £{-impact.gbpPerWeek:.0f} a week more on energy"
    )
    return (
        f"We simulated 14 days of Shoreditch with {'; '.join(change_label(c) for c in changes)}. "
        f"Visits {signed_pct(impact.visits)}, energy {signed_pct(impact.kwh)}, {money}. "
        f"Confidence {confidence}: {basis}. Simulated, not guaranteed."
    )


def _cited_text(response) -> tuple[str, list[dict]]:
    parts: list[str] = []
    citations: list[dict] = []
    for block in response.content:
        if block.type != "text":
            continue
        parts.append(block.text)
        for citation in getattr(block, "citations", None) or []:
            index = getattr(citation, "document_index", None)
            citations.append(
                {
                    "citedText": getattr(citation, "cited_text", ""),
                    "documentIndex": index,
                    "documentTitle": getattr(citation, "document_title", None),
                }
            )
            if index is not None:
                parts.append(f" [{index + 1}]")
    return "".join(parts).strip(), citations


def llm_wording(
    facts: dict, documents: list[Document], *, run: int, session: str | None
) -> tuple[str, list[dict]]:
    """The cited paragraph from settings.REPORT_MODEL (plain text + citations, response-cached)."""
    content: list[dict] = [
        {
            "type": "document",
            "source": {"type": "text", "media_type": "text/plain", "data": d.text},
            "title": d.title,
            "citations": {"enabled": True},
        }
        for d in documents
    ]
    content.append({"type": "text", "text": prompts.report_prompt(facts)})
    model = settings.REPORT_MODEL
    request = {
        "model": model,
        "max_tokens": 4000,
        "system": llm.system_blocks(prompts.REPORT_SYSTEM),
        "messages": [{"role": "user", "content": content}],
        "output_config": {"effort": "low"},
    }
    key = cache.llm_key(model, request)
    hit = cache.llm_get(key)
    if hit is not None:
        llm.record_usage(
            AGENT, model, llm.Usage(**hit["usage"]), run=run, session=session, cached_response=True
        )
        llm.log_event(run, {"agent": AGENT, "type": "cached_response", "key": key})
        return hit["wording"], hit["citations"]
    llm.preflight(session, request)
    llm.log_event(run, {"agent": AGENT, "type": "request", "request": request})
    client = llm.client()
    response = llm.call_with_retries(
        lambda: client.beta.messages.create(
            **request, betas=[llm.FALLBACK_BETA], fallbacks="default"
        ),
        agent=AGENT,
        run=run,
        session=session,
    )
    usage = llm.Usage.from_api(response.usage)
    llm.record_usage(AGENT, model, usage, run=run, session=session)
    wording, citations = _cited_text(response)
    llm.log_event(
        run,
        {
            "agent": AGENT,
            "type": "response",
            "stopReason": response.stop_reason,
            "text": wording,
            "citations": citations,
            "usage": asdict(usage),
        },
    )
    if response.stop_reason in ("refusal", "max_tokens") or not wording:
        raise llm.LLMError(f"report wording: stop_reason={response.stop_reason}")
    cache.llm_put(
        key,
        {"wording": wording, "citations": citations, "usage": asdict(usage), "at": store.now_iso()},
    )
    return wording, citations


# --- PDF -----------------------------------------------------------------------------------------

_PDF_REPLACEMENTS = {
    "→": "->",
    "–": "-",
    "—": "-",
    "’": "'",
    "‘": "'",
    "“": '"',
    "”": '"',
    "…": "...",
}


def _pdf_text(text: str) -> str:
    """fpdf2's core fonts are latin-1 only."""
    for old, new in _PDF_REPLACEMENTS.items():
        text = text.replace(old, new)
    return text.encode("latin-1", "replace").decode("latin-1")


def render_pdf(
    report: StoreReport, ms: MapStore, *, run: int, baseline_run: int, wording: str, basis: str
) -> bytes:
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    def write(text: str, height: float = 6.0) -> None:
        pdf.multi_cell(0, height, _pdf_text(text), align="L", new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    def heading(text: str) -> None:
        pdf.ln(3)
        pdf.set_font("Helvetica", "B", 12)
        write(text, 7)
        pdf.set_font("Helvetica", "", 10)

    pdf.set_font("Helvetica", "B", 16)
    write(f"Weekly report: {ms.name}", 9)
    pdf.set_font("Helvetica", "", 10)
    write(
        f"{ms.type.title()} in Shoreditch | run {run} vs baseline run {baseline_run} | "
        "14 simulated days"
    )
    heading("Recommended changes")
    if report.changes:
        for change in report.changes:
            delta = change.expectedDelta
            write(
                f"- {change_label(change)}   (visits {signed_pct(delta.visits)}, "
                f"energy {signed_pct(delta.kwh)})"
            )
    else:
        write("No change recommended this week.")
    heading("Impact (best run vs baseline)")
    impact = report.impact
    money = "saved" if impact.gbpPerWeek >= 0 else "extra"
    write(
        f"Visits {signed_pct(impact.visits)} | Energy {signed_pct(impact.kwh)} | "
        f"£{abs(impact.gbpPerWeek):.2f} a week {money} on energy"
    )
    write(f"Confidence: {report.confidence} ({basis})")
    heading("Why")
    write(wording)
    heading("Evidence")
    for index, source in enumerate(report.evidence, 1):
        write(f"[{index}] {source.label}: {source.url}")
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 9)
    write(f"{report.note} Approve or reject each change in the app.")
    return bytes(pdf.output())


def _write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _upload_pdf(sid: str, pdf: bytes, run: int, previous: dict | None) -> str | None:
    """Upload the PDF with the Files API, reusing the earlier file when the PDF is unchanged."""
    digest = hashlib.sha256(pdf).hexdigest()
    if previous and previous.get("fileId") and previous.get("pdfSha256") == digest:
        return previous["fileId"]
    try:
        uploaded = llm.client().files.upload(file=(f"{sid}.pdf", pdf, "application/pdf"))
    except anthropic.APIError as e:
        llm.log_event(
            run, {"agent": AGENT, "type": "upload_error", "storeId": sid, "error": str(e)}
        )
        return None
    llm.log_event(run, {"agent": AGENT, "type": "upload", "storeId": sid, "fileId": uploaded.id})
    return uploaded.id


# --- entry point ---------------------------------------------------------------------------------


def write_reports(
    best_run: int,
    baseline_run: int,
    *,
    session: str | None = None,
    store_ids: set[str] | None = None,
    objective: str | None = None,
) -> list[StoreReport]:
    """Write runs/{best_run}/reports/{storeId}.json/.pdf/.meta.json for every non-club store
    (or only `store_ids`, for a one-shop session).

    Confidence is measured on `objective`, the training session's (default settings.OBJECTIVE).
    """
    map_data = store.load_map()
    base, best = rundata.RunFiles.load(baseline_run), rundata.RunFiles.load(best_run)
    advised = [
        ms
        for ms in rundata.advised_stores(map_data)
        if (store_ids is None or ms.id in store_ids)
        and all(ms.id in files.stores and ms.id in files.stats for files in (base, best))
        and ms.id in base.config.stores
        and ms.id in best.config.stores
    ]
    deltas = seed_deltas(base, best, [ms.id for ms in advised], objective=objective)
    cap, cap_reason = calibration_cap()
    chain = _applied_chain(best_run, baseline_run)
    online = llm.available()
    reports_dir = store.run_dir(best_run) / "reports"
    reports = []
    for ms in advised:
        sid = ms.id
        has_changes = bool(config_diff(base.config.stores[sid], best.config.stores[sid]))
        if not has_changes:
            confidence, basis = _capped("high", cap), f"no change; {cap_reason}"
            impact = Impact(visits=0.0, kwh=0.0, gbpPerWeek=0.0)
        elif deltas is None:
            confidence, basis = "low", "extra-seed check unavailable"
            impact = _impact(sid, base, best)
        else:
            confidence = _capped(seed_confidence(deltas[sid]), cap)
            basis = (
                f"{len(deltas[sid])} seeds agree in sign"
                if confidence != "low"
                else (f"{len(deltas[sid])} seeds disagree")
            )
            basis = f"{basis}; {cap_reason}"
            impact = _impact(sid, base, best)
        changes = report_changes(sid, base, best, chain, impact, confidence) if has_changes else []
        documents = _unique([_replay_document(sid, ms, base, best), *_area_documents(ms)])
        report = StoreReport(
            storeId=sid,
            changes=changes,
            impact=impact,
            confidence=confidence,
            evidence=_evidence(documents, ms),
            pdfUrl=f"/files/reports/{best_run}/{sid}.pdf",
        )
        wording = template_wording(ms.name, changes, impact, confidence, basis)
        citations: list[dict] = []
        source = "template"
        if online:
            facts = {
                "store": ms.name,
                "type": ms.type,
                "changes": [change_label(c) for c in changes],
                "impact": impact.model_dump(mode="json"),
                "confidence": confidence,
                "confidenceBasis": basis,
            }
            try:
                wording, citations = llm_wording(facts, documents, run=best_run, session=session)
                source = "llm"
            except (llm.LLMError, anthropic.APIError) as e:
                llm.log_event(
                    best_run,
                    {"agent": AGENT, "type": "wording_fallback", "storeId": sid, "error": str(e)},
                )
        pdf = render_pdf(
            report, ms, run=best_run, baseline_run=baseline_run, wording=wording, basis=basis
        )
        _write_bytes(reports_dir / f"{sid}.pdf", pdf)
        store.write_json(reports_dir / f"{sid}.json", report)
        meta_path = reports_dir / f"{sid}.meta.json"
        previous = store.read_json(meta_path)
        store.write_json(
            meta_path,
            {
                "storeId": sid,
                "run": best_run,
                "baselineRun": baseline_run,
                "wording": wording,
                "wordingSource": source,
                "citations": citations,
                "fileId": _upload_pdf(sid, pdf, best_run, previous) if online else None,
                "pdfSha256": hashlib.sha256(pdf).hexdigest(),
                "seedDeltas": deltas.get(sid) if deltas else None,
                "confidenceBasis": basis,
            },
        )
        reports.append(report)
    llm.log_event(
        best_run,
        {"agent": AGENT, "type": "reports_written", "stores": len(reports), "online": online},
    )
    return reports

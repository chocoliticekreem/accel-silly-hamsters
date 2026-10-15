"""Owner reports: diff, measured impact, honest confidence, evidence, PDF and cited wording."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from test_agents_fakesim import setup_world  # pytest puts tests/ on sys.path

from backend import llm, settings, store
from backend.agents import report, rundata, store_owner
from backend.agents.rules import check_changes
from backend.agents.wording import change_label
from backend.contract import StoreReport, dump


@pytest.fixture
def runs(tmp_path, monkeypatch):
    """Baseline run 1 and an experiment run 2 applying the store agents' s2 and s4 proposals."""
    sim = setup_world(tmp_path, monkeypatch)
    baseline = sim.execute_run(sim.baseline_configs(), 42)
    proposals = [p for p in store_owner.propose_all(baseline) if p.storeId in ("s2", "s4")]
    configs = check_changes(
        rundata.load_config(baseline).stores, proposals, store.load_map()
    ).configs
    best = sim.execute_run(
        configs, 42, parent_run=baseline, applied_changes=[dump(p) for p in proposals]
    )
    return SimpleNamespace(sim=sim, baseline=baseline, best=best)


def reports_by_store(best: int, baseline: int) -> dict[str, StoreReport]:
    return {r.storeId: r for r in report.write_reports(best, baseline)}


def test_seed_confidence_rules():
    assert report.seed_confidence([0.0, 0.0, 0.0]) == "high"
    assert report.seed_confidence([0.10, 0.11, 0.09]) == "high"
    assert report.seed_confidence([0.10, 0.01, 0.20]) == "medium"  # same sign, noisy
    assert report.seed_confidence([0.10, 0.11]) == "medium"  # too few seeds for high
    assert report.seed_confidence([0.10, -0.02, 0.05]) == "low"


@pytest.mark.parametrize(
    ("content", "cap"),
    [
        (None, "medium"),
        ({"measuredCount": 3, "meanError": 0.10}, "high"),
        ({"measuredCount": 3, "meanError": 0.25}, "medium"),
        ({"measuredCount": 3, "meanError": 0.50}, "low"),
        ({"measuredCount": 0, "meanError": None}, "medium"),  # placeholders only
    ],
)
def test_calibration_caps_confidence(tmp_path, monkeypatch, content, cap):
    monkeypatch.setattr(settings, "PROCESSED_DIR", tmp_path)
    if content is not None:
        store.write_json(tmp_path / report.CALIBRATION_EVAL, content)
    assert report.calibration_cap()[0] == cap


def test_reports_carry_the_diff_measured_impact_and_capped_confidence(runs):
    reports = reports_by_store(runs.best, runs.baseline)
    assert sorted(reports) == ["s1", "s2", "s3", "s4"]

    kebab = reports["s2"]
    assert [change_label(c) for c in kebab.changes] == [
        "Close 23:00 → 03:00",
        "Light 00–03: off → low",
    ]
    assert kebab.impact.visits > 0.3 and kebab.impact.kwh > 0 and kebab.impact.gbpPerWeek < 0
    assert sum(c.expectedDelta.visits for c in kebab.changes) == pytest.approx(
        kebab.impact.visits, abs=1e-3
    )
    assert sum(c.expectedDelta.kwh for c in kebab.changes) == pytest.approx(
        kebab.impact.kwh, abs=1e-3
    )
    assert kebab.confidence == "medium"  # seeds agree, but no measured calibration error yet
    assert all(c.confidence == "medium" for c in kebab.changes)

    shop = reports["s4"]
    assert [change_label(c) for c in shop.changes] == [
        "Close 22:00 → 20:00",
        "Light 22–00: low → off",
    ]
    assert shop.impact.kwh < 0 and shop.impact.gbpPerWeek > 0

    cafe = reports["s1"]  # not changed in run 2
    assert cafe.changes == [] and cafe.impact.model_dump() == {
        "visits": 0,
        "kwh": 0,
        "gbpPerWeek": 0,
    }
    meta = store.read_json(settings.RUNS_DIR / str(runs.best) / "reports" / "s1.meta.json")
    assert meta["wording"].startswith("No change recommended")


def test_measured_calibration_allows_high_confidence(runs):
    store.write_json(
        settings.PROCESSED_DIR / report.CALIBRATION_EVAL, {"measuredCount": 2, "meanError": 0.08}
    )
    assert reports_by_store(runs.best, runs.baseline)["s2"].confidence == "high"


def test_confidence_is_low_when_the_seed_check_cannot_run(runs, monkeypatch):
    from backend.sim import runner

    def unavailable(stores, seed):
        raise NotImplementedError

    monkeypatch.setattr(runner, "evaluate", unavailable)
    reports = reports_by_store(runs.best, runs.baseline)
    assert reports["s2"].confidence == "low"
    assert reports["s1"].confidence == "medium"  # no change: nothing to doubt beyond calibration
    log = (settings.RUNS_DIR / str(runs.best) / "llm_log.jsonl").read_text()
    assert "seed_check_unavailable" in log


def test_report_files_evidence_and_pdf(runs):
    reports = reports_by_store(runs.best, runs.baseline)
    folder = settings.RUNS_DIR / str(runs.best) / "reports"
    kebab = StoreReport.model_validate(store.read_json(folder / "s2.json"))
    assert kebab == reports["s2"]
    assert kebab.pdfUrl == f"/files/reports/{runs.best}/s2.pdf"
    assert kebab.note == "Simulated, not guaranteed."
    assert (folder / "s2.pdf").read_bytes().startswith(b"%PDF")

    labels = [e.label for e in kebab.evidence]
    assert kebab.evidence[0].url == f"/api/runs/{runs.best}/days/5"
    assert labels[0] == f"Sim replay, run {runs.best}"
    assert "CIBSE TM46 energy benchmarks (fallback defaults)" in labels  # fallback labelled
    assert "TfL station entries" in labels and len(labels) <= report.MAX_EVIDENCE

    meta = store.read_json(folder / "s2.meta.json")
    assert meta["wordingSource"] == "template" and meta["fileId"] is None
    assert len(meta["seedDeltas"]) == 1 + len(report.EXTRA_SEED_OFFSETS)
    assert "Simulated, not guaranteed." in meta["wording"]


# --- online: cited wording + Files API (mocked client) ---------------------------------------


class FakeReportClient:
    def __init__(self, stop_reason: str = "end_turn"):
        self.requests: list[dict] = []
        self.uploads: list[tuple] = []
        self.stop_reason = stop_reason
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))
        self.files = SimpleNamespace(upload=self.upload)

    def create(self, **kwargs):
        self.requests.append(kwargs)
        citation = SimpleNamespace(
            cited_text="People per day who found the store shut",
            document_index=0,
            document_title="replay",
        )
        return SimpleNamespace(
            content=[
                SimpleNamespace(
                    type="text", text="Opening later catches the club crowd", citations=[citation]
                ),
                SimpleNamespace(type="text", text=". Simulated, not guaranteed.", citations=None),
            ],
            stop_reason=self.stop_reason,
            usage=SimpleNamespace(
                input_tokens=900,
                output_tokens=120,
                cache_read_input_tokens=0,
                cache_creation_input_tokens=400,
            ),
        )

    def upload(self, *, file):
        self.uploads.append(file)
        return SimpleNamespace(id=f"file_{len(self.uploads)}")


def test_online_wording_cites_documents_and_uploads_the_pdf(runs, monkeypatch):
    client = FakeReportClient()
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "client", lambda: client)
    report.write_reports(runs.best, runs.baseline, session="sess")

    assert len(client.requests) == 4 and len(client.uploads) == 4
    request = client.requests[0]
    assert request["model"] == settings.REPORT_MODEL
    assert "format" not in request["output_config"]  # citations cannot use structured outputs
    documents = [b for b in request["messages"][0]["content"] if b["type"] == "document"]
    assert documents and all(d["citations"] == {"enabled": True} for d in documents)
    assert documents[0]["source"]["media_type"] == "text/plain"
    name, data, media_type = client.uploads[0]
    assert name.endswith(".pdf") and data.startswith(b"%PDF") and media_type == "application/pdf"

    meta = store.read_json(settings.RUNS_DIR / str(runs.best) / "reports" / "s2.meta.json")
    assert meta["wordingSource"] == "llm" and meta["fileId"].startswith("file_")
    assert meta["wording"] == "Opening later catches the club crowd [1]. Simulated, not guaranteed."
    assert meta["citations"][0]["documentIndex"] == 0
    assert {r["agent"] for r in llm.load_ledger()} == {"report"}

    report.write_reports(runs.best, runs.baseline, session="sess")
    assert len(client.requests) == 4  # unchanged inputs: wording came from the response cache
    assert len(client.uploads) == 4  # unchanged PDFs keep their Files API ids
    assert sum(r["cachedResponse"] for r in llm.load_ledger()) == 4


def test_online_wording_falls_back_to_the_template_on_refusal(runs, monkeypatch):
    client = FakeReportClient(stop_reason="refusal")
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "client", lambda: client)
    report.write_reports(runs.best, runs.baseline)
    meta = store.read_json(settings.RUNS_DIR / str(runs.best) / "reports" / "s2.meta.json")
    assert meta["wordingSource"] == "template"
    log = [
        json.loads(line) for line in (settings.RUNS_DIR / str(runs.best) / "llm_log.jsonl").open()
    ]
    assert any(e["type"] == "wording_fallback" for e in log)

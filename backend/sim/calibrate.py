"""Compare simulated busyness with the calibration targets and draw the credibility chart.

For each anchor venue in calibration.json that maps to a store, the simulated visits by hour
(weekday and weekend, from a baseline run) and the target busyness are both scaled to a peak of
100 and compared. Writes data/processed/calibration_eval.json (read by the report agent for
honest confidence) and data/processed/calibration.png (the demo slide).

Targets marked measured=false are placeholder shapes, not Popular Times. The chart says so in
every panel title and the eval keeps them out of the error that feeds report confidence, so a
placeholder can never make the sim look validated.
"""

from __future__ import annotations

import numpy as np

from backend import settings, store
from backend.schemas import CalibrationVenue, StoreConfig, StoreStats
from backend.sim import runner

# The web app's palette (apps/web/src/styles.css :root), so the slide matches the History panel.
SIM_COLOR = "#ff9a3d"  # --lamp
TARGET_COLOR = "#848078"  # --context: --text at 50% on --plate
SURFACE = "#181613"  # --plate
INK = "#f0eadd"  # --text
INK_SECONDARY = "#bfb6a6"  # --muted
INK_MUTED = "#a59c8c"  # --faint
GRID = "#292723"  # --grid: --text at 8% on --plate


def _peak_normalise(values: list[float]) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    peak = arr.max()
    return arr * (100.0 / peak) if peak > 0 else arr


def shape_error(sim: list[float], target: list[float]) -> dict[str, float]:
    """Mean absolute error between peak-normalised shapes (0 = identical, 1 = opposite) and r."""
    s, t = _peak_normalise(sim), _peak_normalise(target)
    mae = float(np.mean(np.abs(s - t)) / 100.0)
    r = float(np.corrcoef(s, t)[0, 1]) if s.std() > 0 and t.std() > 0 else 0.0
    return {"mae": round(mae, 4), "r": round(r, 4)}


def evaluate_venues(venues: list[CalibrationVenue], stats: dict[str, StoreStats]) -> list[dict]:
    rows = []
    for venue in venues:
        if venue.storeId is None or venue.storeId not in stats:
            continue
        st = stats[venue.storeId]
        weekday = shape_error(st.visitsByHourWeekday, venue.weekday)
        weekend = shape_error(st.visitsByHourWeekend, venue.weekend)
        rows.append(
            {
                "name": venue.name,
                "storeId": venue.storeId,
                "type": venue.type,
                "measured": venue.measured,
                "weekday": weekday,
                "weekend": weekend,
                "mae": round((weekday["mae"] + weekend["mae"]) / 2, 4),
            }
        )
    return rows


def summarise(rows: list[dict]) -> dict:
    measured = [r for r in rows if r["measured"]]
    return {
        "venues": rows,
        "measuredCount": len(measured),
        # Only measured targets count; placeholder shapes cannot validate the sim.
        "meanError": round(float(np.mean([r["mae"] for r in measured])), 4) if measured else None,
        "note": (
            "Error over measured Popular Times venues only."
            if measured
            else "No measured targets yet: all calibration shapes are placeholders, so the "
            "sim is uncalibrated and report confidence is capped."
        ),
    }


def _chart_fonts() -> tuple[str, str]:
    """(body, heading) font families for matplotlib: the web app's fonts, registered from
    settings.BODY_FONT / HEADING_FONT, or matplotlib's default sans-serif when a file is missing."""
    from matplotlib import font_manager

    families = []
    for path in (settings.BODY_FONT, settings.HEADING_FONT):
        if not path.is_file():
            families.append("sans-serif")
            continue
        if all(f.fname != str(path) for f in font_manager.fontManager.ttflist):
            font_manager.fontManager.addfont(str(path))
        families.append(font_manager.FontProperties(fname=str(path)).get_name())
    return families[0], families[1]


def draw_chart(
    rows: list[dict], venues: list[CalibrationVenue], stats: dict[str, StoreStats], path
) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    body, heading = _chart_fonts()
    by_id = {v.storeId: v for v in venues if v.storeId}
    n = len(rows)
    height = 2.3 * n + 0.8
    fig, axes = plt.subplots(n, 2, figsize=(10, height), squeeze=False, facecolor=SURFACE)
    hours = np.arange(24)
    for i, row in enumerate(rows):
        venue, st = by_id[row["storeId"]], stats[row["storeId"]]
        for j, (label, sim, target) in enumerate(
            [
                ("Weekday", st.visitsByHourWeekday, venue.weekday),
                ("Weekend", st.visitsByHourWeekend, venue.weekend),
            ]
        ):
            ax = axes[i][j]
            ax.set_facecolor(SURFACE)
            ax.plot(hours, _peak_normalise(sim), color=SIM_COLOR, linewidth=2, label="Simulated")
            ax.plot(
                hours,
                _peak_normalise(target),
                color=TARGET_COLOR,
                linewidth=2,
                linestyle="--",
                label="Popular Times" if venue.measured else "Placeholder shape",
            )
            kind = "measured" if venue.measured else "placeholder, not measured"
            ax.set_title(
                f"{venue.name} · {label} ({kind})",
                fontsize=9,
                color=INK,
                loc="left",
                fontfamily=body,
            )
            ax.set_xlim(0, 23)
            ax.set_ylim(0, 110)
            ax.set_xticks([0, 6, 12, 18, 23])
            ax.tick_params(colors=INK_MUTED, labelsize=8, labelfontfamily=body)
            ax.grid(axis="y", color=GRID, linewidth=0.6)
            for spine in ax.spines.values():
                spine.set_visible(False)
            err = row["weekday" if j == 0 else "weekend"]["mae"]
            ax.text(
                0.99,
                0.92,
                f"shape error {err:.2f}",
                transform=ax.transAxes,
                ha="right",
                fontsize=8,
                color=INK_SECONDARY,
                fontfamily=body,
            )
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(
        handles,
        labels,
        loc="upper right",
        frameon=False,
        prop={"family": body, "size": 9},
        labelcolor=INK,
    )
    # Hammersmith One's 1 and 0 read as I and O, so the heading holds words only and the scale
    # goes on a body-font line under it (numbers are always in the body font, as on the web).
    fig.suptitle(
        "Busyness by hour",
        x=0.01,
        y=1 - 0.12 / height,
        ha="left",
        va="top",
        fontsize=11,
        color=INK,
        fontfamily=heading,
    )
    fig.text(
        0.01,
        1 - 0.38 / height,
        "Scaled to peak = 100",
        ha="left",
        va="top",
        fontsize=9,
        color=INK_SECONDARY,
        fontfamily=body,
    )
    fig.tight_layout(rect=(0, 0, 1, 1 - 0.6 / height))
    fig.savefig(path, dpi=150, facecolor=SURFACE)
    plt.close(fig)


def run(seed: int = settings.DEFAULT_SEED, configs: dict[str, StoreConfig] | None = None) -> dict:
    calibration = store.load_calibration()
    result = runner.evaluate(configs or runner.baseline_configs(), seed)
    rows = evaluate_venues(calibration.venues, result.stats)
    summary = summarise(rows)
    store.write_json(settings.PROCESSED_DIR / "calibration_eval.json", summary)
    if rows:
        draw_chart(
            rows, calibration.venues, result.stats, settings.PROCESSED_DIR / "calibration.png"
        )
    return summary

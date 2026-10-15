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

SIM_COLOR = "#2a78d6"
TARGET_COLOR = "#eb6834"
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
INK_MUTED = "#898781"
GRID = "#e1e0d9"


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


def draw_chart(
    rows: list[dict], venues: list[CalibrationVenue], stats: dict[str, StoreStats], path
) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    by_id = {v.storeId: v for v in venues if v.storeId}
    n = len(rows)
    fig, axes = plt.subplots(n, 2, figsize=(10, 2.3 * n + 0.8), squeeze=False, facecolor=SURFACE)
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
                linestyle="-" if venue.measured else "--",
                label="Popular Times" if venue.measured else "Placeholder shape",
            )
            kind = "measured" if venue.measured else "placeholder, not measured"
            ax.set_title(f"{venue.name} · {label} ({kind})", fontsize=9, color=INK, loc="left")
            ax.set_xlim(0, 23)
            ax.set_ylim(0, 110)
            ax.set_xticks([0, 6, 12, 18, 23])
            ax.tick_params(colors=INK_MUTED, labelsize=8)
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
            )
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper right", frameon=False, fontsize=9)
    fig.suptitle(
        "Busyness by hour, scaled to peak = 100", x=0.01, ha="left", fontsize=11, color=INK
    )
    fig.tight_layout(rect=(0, 0, 1, 0.97))
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

"""Street graph, routing and keyframes (backend/sim/movement.py)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.contract import Building, Street
from backend.sim import movement


def street(sid: str, *points: tuple[float, float]) -> Street:
    return Street(id=sid, name=sid, points=list(points), width=8)


def test_t_junction_and_crossing_become_shared_nodes() -> None:
    streets = [
        street("main", (0, -100), (0, 100)),
        street("cross", (-100, 0), (100, 0)),  # crosses main mid-segment
        street("spur", (50, 0), (50, 100)),  # ends on the middle of cross: a T-junction
    ]
    places = [(0.0, 100.0), (50.0, 100.0)]
    graph, nodes = movement.build_walk_graph(streets, places)
    routes = movement.Routes(graph, nodes)
    # Without the junctions there is no way from the top of main to the top of spur.
    assert routes.dist[0, 1] == pytest.approx(100 + 50 + 100)
    assert routes.corners(0, 1) == [(0.0, 100.0), (0.0, 0.0), (50.0, 0.0), (50.0, 100.0)]


def test_detached_street_is_joined_and_every_place_reachable() -> None:
    streets = [street("a", (0, 0), (100, 0)), street("island", (0, 50), (100, 50))]
    graph, nodes = movement.build_walk_graph(streets, [(0.0, 0.0), (100.0, 50.0)])
    routes = movement.Routes(graph, nodes)
    assert len(movement._components(graph)) == 1
    assert math.isfinite(routes.dist[0, 1])
    assert routes.dist[0, 1] == pytest.approx(150)


def test_places_hang_off_their_nearest_street() -> None:
    streets = [street("a", (0, 0), (100, 0))]
    graph, nodes = movement.build_walk_graph(streets, [(30.0, 8.0), (80.0, -5.0)])
    routes = movement.Routes(graph, nodes)
    assert routes.corners(0, 1) == [(30.0, 8.0), (30.0, 0.0), (80.0, 0.0), (80.0, -5.0)]
    assert routes.dist[0, 1] == pytest.approx(8 + 50 + 5)


def test_door_faces_the_nearest_street() -> None:
    segs = movement.street_segments([street("a", (-100, 0), (100, 0))])
    building = Building(id="b", kind="store", x=10, z=20, w=12, d=10, h=8)
    assert movement.door_point(building, segs) == pytest.approx((10.0, 15.0))


def segment_speeds(frames: list[movement.Keyframe]) -> list[float]:
    """Metres per second between consecutive keyframes."""
    return [
        math.hypot(x1 - x0, z1 - z0) / ((t1 - t0) * 60)
        for (t0, x0, z0), (t1, x1, z1) in zip(frames, frames[1:], strict=False)
    ]


def test_walk_keyframes_are_integer_minutes_strictly_increasing() -> None:
    corners = [(0.0, 0.0), (5.0, 0.0), (5.0, 3.0), (200.0, 3.0)]
    frames = movement.walk(corners, 600)
    times = [t for t, _, _ in frames]
    assert frames[0] == (600, 0.0, 0.0)
    assert all(isinstance(t, int) for t in times)
    assert all(b > a for a, b in zip(times, times[1:], strict=False))


def test_walk_never_sprints_after_short_corners() -> None:
    """Many short jogs push corners a minute later each; the long leg after them must still be
    walked at walking pace instead of catching up."""
    jogs = [(float(i * 4), float(i % 2 * 3)) for i in range(8)]
    corners = [*jogs, (28.0 + 400.0, 3.0)]
    frames = movement.walk(corners, 0)
    assert max(segment_speeds(frames)) <= 2.0  # 1.3 m/s give or take minute rounding
    long_leg = frames[-1][0] - frames[-2][0]
    assert long_leg == pytest.approx(400 / movement.WALK_SPEED_M_PER_MIN, abs=1)


def test_simplify_keeps_only_corners() -> None:
    pts = [(0.0, 0.0), (10.0, 0.0), (20.0, 0.0), (20.0, 0.2), (20.0, 10.0), (20.0, 10.0)]
    assert movement.simplify(pts) == [(0.0, 0.0), (20.0, 0.0), (20.0, 10.0)]


def test_passes_near_reports_closest_approach_minute() -> None:
    segments = np.array([[0, -100, 0, 10, 100, 0], [10, 100, 0, 20, 100, 200]], dtype=float)
    doors = np.array([[0.0, 30.0], [0.0, 90.0]])
    seg, door, minute = movement.passes_near(segments, doors, 60.0)
    assert list(zip(seg.tolist(), door.tolist(), minute.tolist(), strict=True)) == [(0, 0, 5)]

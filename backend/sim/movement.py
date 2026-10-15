"""Walking on the street graph: build it from map.json, route between places, emit keyframes.

Graph nodes are street polyline points, street crossings (including T-junctions where one street
ends on another) and the projection of every place (store door or entry point) onto its nearest
street segment. Each place hangs off its projection by a short straight edge, so a route runs
door -> street -> ... -> street -> door. Street pieces that do not touch the main network are
joined to it by their closest node pair, so every place can reach every other place.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from itertools import pairwise

import numpy as np

from backend.contract import Building, Street

WALK_SPEED_M_PER_MIN = 1.3 * 60
SNAP_M = 1.0  # points closer than this are one node; also the T-junction tolerance
COLLINEAR_SIN = math.sin(math.radians(3))  # direction changes below this are not corners

Point = tuple[float, float]
Keyframe = tuple[int, float, float]
# A corner polyline ready to walk: the rounded start, then (minutes, x, z) per leg.
Legs = tuple[Point, list[tuple[float, float, float]]]


@dataclass
class WalkGraph:
    xy: np.ndarray  # (N, 2) node coordinates
    adj: list[dict[int, float]] = field(default_factory=list)  # node -> {neighbour: metres}

    def add_edge(self, a: int, b: int) -> None:
        if a == b:
            return
        length = float(np.hypot(*(self.xy[a] - self.xy[b])))
        if length < self.adj[a].get(b, math.inf):
            self.adj[a][b] = length
            self.adj[b][a] = length


def street_segments(streets: list[Street]) -> np.ndarray:
    """(M, 4) array of [ax, az, bx, bz] for every non-degenerate street segment."""
    segs = [
        (*a, *b) for street in streets for a, b in pairwise(street.points) if math.dist(a, b) > 1e-6
    ]
    return np.asarray(segs, dtype=float).reshape(-1, 4)


def nearest_on_segments(segs: np.ndarray, x: float, z: float) -> tuple[int, float, float, float]:
    """(segment index, t along it, px, pz) of the closest street point to (x, z)."""
    a, b = segs[:, :2], segs[:, 2:]
    ab = b - a
    t = np.clip(((x - a[:, 0]) * ab[:, 0] + (z - a[:, 1]) * ab[:, 1]) / (ab**2).sum(1), 0, 1)
    proj = a + ab * t[:, None]
    k = int(np.argmin(np.hypot(proj[:, 0] - x, proj[:, 1] - z)))
    return k, float(t[k]), float(proj[k, 0]), float(proj[k, 1])


def door_point(building: Building, segs: np.ndarray) -> Point:
    """Where a store's door sits: the point of its footprint facing the nearest street.

    Buildings are axis-aligned boxes centred on (x, z), width w along x and depth d along z.
    """
    if len(segs) == 0:
        return building.x, building.z
    _, _, px, pz = nearest_on_segments(segs, building.x, building.z)
    half_w, half_d = building.w / 2, building.d / 2
    dx = min(max(px, building.x - half_w), building.x + half_w)
    dz = min(max(pz, building.z - half_d), building.z + half_d)
    return dx, dz


def _segment_cuts(segs: np.ndarray) -> list[list[tuple[float, float, float]]]:
    """Per segment, the (t, x, z) points where it meets other segments, endpoints included."""
    cuts: list[list[tuple[float, float, float]]] = [
        [(0.0, s[0], s[1]), (1.0, s[2], s[3])] for s in segs
    ]
    # Broad phase: segments can only meet (within SNAP_M) where their bounding boxes, padded by
    # SNAP_M, overlap; the padding is doubled so float rounding never drops a meeting.
    pad = 2 * SNAP_M
    lo = np.minimum(segs[:, :2], segs[:, 2:]) - pad
    hi = np.maximum(segs[:, :2], segs[:, 2:]) + pad
    for i in range(len(segs)):
        later = slice(i + 1, None)
        overlap = (
            (lo[later, 0] <= hi[i, 0])
            & (hi[later, 0] >= lo[i, 0])
            & (lo[later, 1] <= hi[i, 1])
            & (hi[later, 1] >= lo[i, 1])
        )
        for j in np.flatnonzero(overlap) + i + 1:
            for ti, tj, x, z in _meetings(segs[i], segs[j]):
                cuts[i].append((ti, x, z))
                cuts[j].append((tj, x, z))
    return cuts


def _meetings(s1: np.ndarray, s2: np.ndarray) -> list[tuple[float, float, float, float]]:
    """Points where two segments cross or touch within SNAP_M, as (t1, t2, x, z)."""
    p, r = s1[:2], s1[2:] - s1[:2]
    q, s = s2[:2], s2[2:] - s2[:2]
    out = []
    denom = r[0] * s[1] - r[1] * s[0]
    if abs(denom) > 1e-9:
        t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / denom
        u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / denom
        tol_t, tol_u = SNAP_M / math.hypot(*r), SNAP_M / math.hypot(*s)
        if -tol_t <= t <= 1 + tol_t and -tol_u <= u <= 1 + tol_u:
            t, u = min(max(t, 0.0), 1.0), min(max(u, 0.0), 1.0)
            x, z = p + r * t
            out.append((float(t), float(u), float(x), float(z)))
        return out
    # Parallel: shared stretches only meet where an endpoint of one lies on the other.
    for (a, ab), (other_a, other_ab), swap in (((p, r), (q, s), False), ((q, s), (p, r), True)):
        for endpoint_t, end in ((0.0, a), (1.0, a + ab)):
            v = float(np.clip(np.dot(end - other_a, other_ab) / np.dot(other_ab, other_ab), 0, 1))
            if math.dist(end, other_a + other_ab * v) <= SNAP_M:
                pair = (v, endpoint_t) if swap else (endpoint_t, v)
                out.append((pair[0], pair[1], float(end[0]), float(end[1])))
    return out


class _NodeIndex:
    """Merges points within SNAP_M into one node (spatial hash over SNAP_M cells)."""

    def __init__(self) -> None:
        self.xy: list[Point] = []
        self._cells: dict[tuple[int, int], list[int]] = {}

    def get(self, x: float, z: float) -> int:
        cx, cz = math.floor(x / SNAP_M), math.floor(z / SNAP_M)
        for dx in (-1, 0, 1):
            for dz in (-1, 0, 1):
                for n in self._cells.get((cx + dx, cz + dz), []):
                    if math.dist(self.xy[n], (x, z)) <= SNAP_M:
                        return n
        self.xy.append((x, z))
        self._cells.setdefault((cx, cz), []).append(len(self.xy) - 1)
        return len(self.xy) - 1


def build_walk_graph(streets: list[Street], places: list[Point]) -> tuple[WalkGraph, list[int]]:
    """Street graph with every place attached. Returns (graph, node id per place)."""
    segs = street_segments(streets)
    cuts = _segment_cuts(segs)
    projections: list[Point | None] = []
    for x, z in places:
        if len(segs) == 0:
            projections.append(None)
            continue
        k, t, px, pz = nearest_on_segments(segs, x, z)
        cuts[k].append((t, px, pz))
        projections.append((px, pz))

    index = _NodeIndex()
    edges: list[tuple[int, int]] = []
    for seg_cuts in cuts:
        nodes = [index.get(x, z) for _, x, z in sorted(seg_cuts)]
        edges += [(a, b) for a, b in pairwise(nodes) if a != b]
    place_nodes = []
    for (x, z), proj in zip(places, projections, strict=True):
        node = index.get(x, z)
        if proj is not None:
            edges.append((node, index.get(*proj)))
        place_nodes.append(node)

    graph = WalkGraph(xy=np.asarray(index.xy, dtype=float).reshape(-1, 2))
    graph.adj = [{} for _ in index.xy]
    for a, b in edges:
        graph.add_edge(a, b)
    _connect_components(graph)
    return graph, place_nodes


def _components(graph: WalkGraph) -> list[list[int]]:
    seen = [False] * len(graph.adj)
    comps = []
    for start in range(len(graph.adj)):
        if seen[start]:
            continue
        seen[start] = True
        stack, comp = [start], []
        while stack:
            n = stack.pop()
            comp.append(n)
            for m in graph.adj[n]:
                if not seen[m]:
                    seen[m] = True
                    stack.append(m)
        comps.append(comp)
    return comps


def _connect_components(graph: WalkGraph) -> None:
    """Join every detached piece to the largest one through its closest node pair."""
    comps = _components(graph)
    if len(comps) <= 1:
        return
    comps.sort(key=lambda c: (-len(c), min(c)))
    main = list(comps[0])
    for comp in comps[1:]:
        a, b = np.asarray(comp), np.asarray(main)
        d = np.hypot(*(graph.xy[a][:, None, :] - graph.xy[b][None, :, :]).transpose(2, 0, 1))
        i, j = np.unravel_index(int(np.argmin(d)), d.shape)
        graph.add_edge(int(a[i]), int(b[j]))
        main += comp


def dijkstra(graph: WalkGraph, source: int) -> tuple[np.ndarray, np.ndarray]:
    """Shortest walking distance and predecessor from `source` to every node."""
    n = len(graph.adj)
    dist = np.full(n, np.inf)
    prev = np.full(n, -1, dtype=np.int64)
    dist[source] = 0.0
    heap = [(0.0, source)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist[u]:
            continue
        for v, w in graph.adj[u].items():
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    return dist, prev


def simplify(points: list[Point]) -> list[Point]:
    """Drop repeated points and points where the direction does not change (not corners)."""
    out: list[Point] = []
    for p in points:
        if out and math.dist(out[-1], p) < 0.5:
            continue
        if len(out) >= 2:
            (ax, az), (bx, bz) = out[-2], out[-1]
            v1, v2 = (bx - ax, bz - az), (p[0] - bx, p[1] - bz)
            cross = v1[0] * v2[1] - v1[1] * v2[0]
            dot = v1[0] * v2[0] + v1[1] * v2[1]
            if dot > 0 and abs(cross) <= COLLINEAR_SIN * math.hypot(*v1) * math.hypot(*v2):
                out[-1] = p
                continue
        out.append(p)
    return out


class Routes:
    """All-pairs shortest walks between places (store doors and entry points)."""

    def __init__(self, graph: WalkGraph, place_nodes: list[int]) -> None:
        self.graph = graph
        self.place_nodes = place_nodes
        n = len(place_nodes)
        self.dist = np.zeros((n, n))
        self._prev: list[np.ndarray] = []
        for i, node in enumerate(place_nodes):
            dist, prev = dijkstra(graph, node)
            self.dist[i] = dist[place_nodes]
            self._prev.append(prev)
        self._corners: dict[tuple[int, int], list[Point]] = {}
        self._legs: dict[tuple[int, int], Legs] = {}

    def corners(self, a: int, b: int) -> list[Point]:
        """Corner points of the shortest walk from place a to place b, both ends included."""
        key = (a, b)
        if key not in self._corners:
            prev, node, target = self._prev[a], self.place_nodes[b], self.place_nodes[a]
            chain = [node]
            while node != target:
                node = int(prev[node])
                if node < 0:
                    raise ValueError(f"place {b} is not reachable from place {a}")
                chain.append(node)
            pts = [(float(self.graph.xy[n][0]), float(self.graph.xy[n][1])) for n in chain[::-1]]
            self._corners[key] = simplify(pts)
        return self._corners[key]

    def legs(self, a: int, b: int) -> Legs:
        """corners(a, b) prepared for walk_legs (cached: trips repeat the same routes)."""
        key = (a, b)
        if key not in self._legs:
            self._legs[key] = legs_of(self.corners(a, b))
        return self._legs[key]


def legs_of(corners: list[Point]) -> Legs:
    x0, z0 = corners[0]
    return (round(x0, 1), round(z0, 1)), [
        (math.hypot(bx - ax, bz - az) / WALK_SPEED_M_PER_MIN, round(bx, 1), round(bz, 1))
        for (ax, az), (bx, bz) in pairwise(corners)
    ]


def walk(corners: list[Point], t_start: int) -> list[Keyframe]:
    """Keyframes for walking a corner polyline from t_start at WALK_SPEED_M_PER_MIN."""
    return walk_legs(legs_of(corners), t_start)


def walk_legs(legs: Legs, t_start: int) -> list[Keyframe]:
    """Keyframes for walking prepared legs from t_start.

    Times are integer minutes and strictly increasing, so a corner closer than one minute's walk
    to the previous one is reached a minute later instead (no zero-duration jumps). The walking
    clock then restarts from that later minute: catching up on a following long segment would
    make the agent sprint.
    """
    (x0, z0), steps = legs
    frames: list[Keyframe] = [(t_start, x0, z0)]
    clock = float(t_start)
    last = t_start
    for minutes, x, z in steps:
        clock += minutes
        t = math.floor(clock + 0.5)
        if t <= last:
            t = last + 1
            clock = float(t)
        frames.append((t, x, z))
        last = t
    return frames


def passes_near(
    segments: np.ndarray, doors: np.ndarray, radius: float
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Which walking segments pass within `radius` of which doors, and when.

    segments: (K, 6) rows of [t0, x0, z0, t1, x1, z1]; doors: (S, 2).
    Returns (segment index, door index, minute of closest approach) for every hit, ordered by
    segment, then door.
    """
    if len(segments) == 0:
        empty = np.zeros(0, dtype=np.int64)
        return empty, empty, empty
    # Broad phase: a door can only be within `radius` of a segment inside the segment's
    # bounding box padded by `radius` (plus a metre, so float rounding never drops a hit).
    pad = radius + 1.0
    lo = np.minimum(segments[:, 1:3], segments[:, 4:6]) - pad
    hi = np.maximum(segments[:, 1:3], segments[:, 4:6]) + pad
    near = (
        (doors[None, :, 0] >= lo[:, None, 0])
        & (doors[None, :, 0] <= hi[:, None, 0])
        & (doors[None, :, 1] >= lo[:, None, 1])
        & (doors[None, :, 1] <= hi[:, None, 1])
    )
    seg_idx, door_idx = np.nonzero(near)
    a, b = segments[seg_idx, 1:3], segments[seg_idx, 4:6]
    door = doors[door_idx]
    ab = b - a
    length2 = np.maximum((ab**2).sum(-1), 1e-12)
    u = np.clip(((door - a) * ab).sum(-1) / length2, 0.0, 1.0)
    closest = a + ab * u[:, None]
    hit = np.hypot(*(closest - door).T) <= radius
    seg_idx, door_idx, u = seg_idx[hit], door_idx[hit], u[hit]
    t0, t1 = segments[seg_idx, 0], segments[seg_idx, 3]
    minute = np.floor(t0 + (t1 - t0) * u).astype(np.int64)
    return seg_idx, door_idx, minute

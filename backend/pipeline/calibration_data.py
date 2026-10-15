"""calibration.json: hourly busyness (0-100) for 3-5 anchor venues in the map.

This is the ground truth backend/sim/calibrate.py compares simulated visits against (the
credibility chart). Every venue is matched to a store in data/processed/map.json:

  * Measured: Popular Times style data from BestTime (BESTTIME_API_KEY) or Outscraper
    (OUTSCRAPER_API_KEY), looked up by the store's name and accepted only when the venue the
    provider found has the same name.
  * Placeholder (what runs without keys): a hand-written typical shape for the store's venue
    type, matched by type, with measured=False and fallback=True. A placeholder is never
    evidence that the sim is calibrated.

Busyness uses the Popular Times scale: 100 = the venue's busiest hour of the week. `weekday`
averages the Mon-Fri calendar days and `weekend` Sat-Sun, and an hour after midnight belongs to
the next calendar day (Fri 01:00 counts as Saturday), the same convention as StoreStats. Both
providers report a "venue day" that runs past midnight, so those hours move to the next day
before averaging.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import httpx

from backend import cache, store
from backend.contract import MapData, MapStore, Source, StoreType
from backend.pipeline import common
from backend.schemas import CalibrationFile, CalibrationVenue

log = logging.getLogger(__name__)

STEP = "calibration"
MIN_VENUES = 3
STATION_XZ = (0.0, 0.0)  # contract origin: Shoreditch High St station

BESTTIME_KEY_ENV = "BESTTIME_API_KEY"
OUTSCRAPER_KEY_ENV = "OUTSCRAPER_API_KEY"
BESTTIME_FORECAST_URL = "https://besttime.app/api/v1/forecasts"
OUTSCRAPER_SEARCH_URL = "https://api.outscraper.cloud/google-maps-search"
VENUE_AREA = "Shoreditch, London, UK"  # appended to a store's name for provider lookups
BESTTIME_DAY_START_HOUR = 6  # day_raw[0] is 06:00 and day_raw[23] is 05:00 the next morning

WEEKDAY_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
WEEKEND = (5, 6)  # Saturday and Sunday, with Monday = 0

# Filler words dropped before comparing venue names ("Dishoom Shoreditch" ~ "Dishoom").
NAME_STOPWORDS = frozenset({"the", "and", "ltd", "london", "shoreditch", "uk"})

Week = list[list[float]]  # [calendar day, Monday = 0][clock hour] -> busyness 0..100


class ProviderDataError(ValueError):
    """A provider answered, but not with usable Popular Times data for this store."""


@dataclass(frozen=True)
class PlaceholderShape:
    """A typical hourly busyness pattern for one venue type: hand-written, not measured.

    Hours are sparse {clock hour: busyness}; missing hours are 0 (closed). The values are
    already on calendar days, so weekend 00-04 are Friday and Saturday nights.
    """

    store_type: StoreType
    weekday: dict[int, float]
    weekend: dict[int, float]
    basis: str  # one line on the shape, copied into the file's notes


PLACEHOLDER_SHAPES: dict[str, PlaceholderShape] = {
    "cafe": PlaceholderShape(
        store_type="cafe",
        weekday={
            7: 22, 8: 55, 9: 62, 10: 50, 11: 46, 12: 56, 13: 54, 14: 40, 15: 35, 16: 28, 17: 15,
        },
        weekend={8: 12, 9: 35, 10: 62, 11: 82, 12: 90, 13: 86, 14: 72, 15: 55, 16: 38, 17: 20},
        basis="weekday commuter rush 08-10 and lunch, weekend brunch peak 11-14",
    ),
    "restaurant": PlaceholderShape(
        store_type="restaurant",
        weekday={
            11: 5, 12: 32, 13: 38, 14: 22, 15: 10, 16: 10, 17: 20, 18: 42, 19: 60, 20: 64,
            21: 48, 22: 26, 23: 8,
        },
        weekend={
            10: 6, 11: 15, 12: 42, 13: 52, 14: 44, 15: 28, 16: 25, 17: 34, 18: 56, 19: 78,
            20: 84, 21: 70, 22: 42, 23: 15,
        },
        basis="lunch 12-14 and a bigger dinner peak 19-21, busiest on Saturday",
    ),
    "bar": PlaceholderShape(
        store_type="bar",
        weekday={
            0: 14, 1: 5, 12: 6, 13: 8, 14: 8, 15: 10, 16: 16, 17: 30, 18: 42, 19: 50, 20: 55,
            21: 58, 22: 52, 23: 36,
        },
        weekend={
            0: 76, 1: 52, 2: 20, 3: 4, 12: 16, 13: 24, 14: 30, 15: 34, 16: 40, 17: 46, 18: 52,
            19: 58, 20: 64, 21: 68, 22: 72, 23: 74,
        },
        basis="after-work rise from 17:00, latest and busiest on Friday and Saturday nights",
    ),
    "club": PlaceholderShape(
        store_type="club",
        weekday={0: 10, 1: 12, 2: 11, 22: 6, 23: 14},
        weekend={0: 76, 1: 95, 2: 90, 22: 10, 23: 22},
        basis="open Thu-Sat 22:00-03:00, peak 01-02 on Friday and Saturday nights",
    ),
    "late-night takeaway": PlaceholderShape(
        store_type="takeaway",
        weekday={
            0: 22, 1: 12, 2: 10, 3: 9, 4: 4, 11: 8, 12: 28, 13: 30, 14: 18, 15: 12, 16: 14,
            17: 24, 18: 40, 19: 50, 20: 50, 21: 42, 22: 34, 23: 28,
        },
        weekend={
            0: 50, 1: 62, 2: 76, 3: 90, 4: 44, 5: 8, 11: 10, 12: 30, 13: 36, 14: 30, 15: 22,
            16: 22, 17: 30, 18: 42, 19: 52, 20: 55, 21: 48, 22: 44, 23: 46,
        },
        basis="lunch, dinner 18-21 and an after-club peak 02-04 on Friday and Saturday nights",
    ),
}  # fmt: skip

PLACEHOLDER_NOTE = (
    "PLACEHOLDER, NOT MEASURED: {placeholders} of {total} venues (measured=false) are "
    "hand-written shapes of the hourly pattern Google Popular Times typically shows for the "
    "venue type, not data for these venues. They cannot validate the sim: calibration error "
    "and report confidence must leave them out."
)
SCALE_NOTE = (
    "Scale: 0-100 = share of the venue's busiest hour of the week (Popular Times scale). "
    "weekday = mean of the Mon-Fri calendar days, weekend = Sat-Sun; an hour after midnight "
    "belongs to the next calendar day (Fri 01:00 counts as Saturday), as in StoreStats."
)
NO_KEYS_NOTE = (
    "Popular Times needs a paid API key: BESTTIME_API_KEY and OUTSCRAPER_API_KEY are not set "
    "(SerpAPI is key-gated too and not wired in), so no venue was measured."
)
DATASTORE_NOTE = (
    "London Datastore checked 2026-10-15 (all 1306 datasets): no open hourly high-street "
    "footfall for Shoreditch, Hackney or Tower Hamlets. Closest: Google Mobility by Borough "
    "(daily % change, All Rights Reserved, ended Oct 2022), the COVID-19 Mobility Report "
    "footfall series (daily, London-wide) and LTDS 'Trips made in London by time of day' "
    "(London-wide weekday trip starts). GLA High Streets Data Service footfall is not in the "
    "open catalogue (only its boundaries, dataset 2rq4w)."
)


@dataclass(frozen=True)
class Anchor:
    """A map store picked as a calibration anchor, and why it was picked (copied into notes)."""

    slot: str  # a PLACEHOLDER_SHAPES key
    store: MapStore
    reason: str


@dataclass(frozen=True)
class ProviderKeys:
    """Popular Times API keys from the environment. Never printed, hashed or written to disk."""

    besttime: str | None = field(default=None, repr=False)
    outscraper: str | None = field(default=None, repr=False)

    @classmethod
    def from_env(cls) -> ProviderKeys:
        return cls(
            besttime=os.getenv(BESTTIME_KEY_ENV) or None,
            outscraper=os.getenv(OUTSCRAPER_KEY_ENV) or None,
        )

    def redact(self, text: str) -> str:
        for key in (self.besttime, self.outscraper):
            if key:
                text = text.replace(key, "***")
        return text


# --- build ----------------------------------------------------------------------------------


def build(map_data: MapData | None = None, refresh: bool = False) -> CalibrationFile:
    """Build data/processed/calibration.json for the current map (or `map_data`).

    Rebuilds only when the map's stores, this module's code or which provider keys are set
    change, or when refresh=True. Provider responses are cached in data/raw/ and re-fetched only
    under the --refresh cache policy.
    """
    if map_data is None:
        map_data = store.load_map()
    keys = ProviderKeys.from_env()
    inputs = _cache_inputs(map_data, keys)
    if not refresh and cache.pipeline_up_to_date(STEP, inputs):
        return store.load_calibration()
    calibration = assemble(map_data, keys)
    common.write_processed("calibration.json", calibration)
    cache.pipeline_mark(STEP, inputs)
    return calibration


def assemble(map_data: MapData, keys: ProviderKeys) -> CalibrationFile:
    """The calibration file for this map: measured venues where a provider has them, labelled
    placeholders elsewhere. No pipeline caching and no writes."""
    anchors = select_anchors(map_data)
    provider_notes: list[str] = []
    venues = [_venue_for(anchor, keys, provider_notes) for anchor in anchors]
    placeholders = sum(not venue.measured for venue in venues)
    notes = []
    if placeholders:
        notes.append(PLACEHOLDER_NOTE.format(placeholders=placeholders, total=len(venues)))
    if len(venues) < MIN_VENUES:
        notes.append(
            f"Only {len(venues)} anchor venues in map.json (want {MIN_VENUES}-5): the map lacks "
            "some of cafe, restaurant, bar, club and takeaway."
        )
    notes.append(SCALE_NOTE)
    notes += [_anchor_note(a, v) for a, v in zip(anchors, venues, strict=True)]
    notes += provider_notes
    notes.append(_keys_note(keys))
    notes.append(DATASTORE_NOTE)
    return CalibrationFile(
        venues=venues,
        sources=[v.source for v in venues if v.measured and v.source is not None],
        fallback=placeholders > 0,
        notes=notes,
    )


def _cache_inputs(map_data: MapData, keys: ProviderKeys) -> dict[str, Any]:
    """What the output depends on: the map's stores, which keys are set, and this module's
    source, so edited shapes or logic rebuild without --refresh (provider data stays cached)."""
    positions = _store_positions(map_data)
    return {
        "stores": [[s.id, s.name, s.type, s.osmId, positions.get(s.id)] for s in map_data.stores],
        "providers": {"besttime": bool(keys.besttime), "outscraper": bool(keys.outscraper)},
        "code": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }


def _venue_for(anchor: Anchor, keys: ProviderKeys, notes: list[str]) -> CalibrationVenue:
    """Measured data from the first provider with a key that has this venue, else the
    labelled placeholder. Provider failures are noted (redacted), never raised."""
    has_key = bool(keys.besttime or keys.outscraper)
    if anchor.store.osmId is None:
        if has_key:
            notes.append(
                f"{anchor.store.id}: provider lookup skipped, not an OpenStreetMap venue "
                "(fallback map names are made up)."
            )
        return placeholder_venue(anchor)
    lookups = (
        ("BestTime", keys.besttime, besttime_venue),
        ("Outscraper", keys.outscraper, outscraper_venue),
    )
    for provider, key, lookup in lookups:
        if not key:
            continue
        try:
            return lookup(anchor, key)
        except (common.FetchError, ValueError) as e:
            message = keys.redact(str(e))
            log.warning("calibration: %s: no data for %s: %s", provider, anchor.store.id, message)
            notes.append(
                f"{anchor.store.id}: {provider} gave no usable data ({message}); "
                "pipeline --refresh retries."
            )
    return placeholder_venue(anchor)


def _anchor_note(anchor: Anchor, venue: CalibrationVenue) -> str:
    if venue.measured and venue.source is not None:
        what = f"measured: {venue.source.label}"
    else:
        what = f"placeholder ({PLACEHOLDER_SHAPES[anchor.slot].basis})"
    s = anchor.store
    return f"{s.id} {s.name} ({s.type}) is {anchor.reason}; {what}."


def _keys_note(keys: ProviderKeys) -> str:
    named = (("BestTime", keys.besttime), ("Outscraper", keys.outscraper))
    used = [provider for provider, key in named if key]
    if not used:
        return NO_KEYS_NOTE
    return f"Popular Times providers with a key: {', '.join(used)}. SerpAPI is not wired in."


# --- anchors --------------------------------------------------------------------------------


def select_anchors(map_data: MapData) -> list[Anchor]:
    """Pick up to five anchor stores: the cafe, restaurant and bar nearest the station, then
    the takeaway nearest a club together with that club (the demo's spill-out pair)."""
    positions = _store_positions(map_data)
    by_type: dict[str, list[MapStore]] = {}
    for map_store in map_data.stores:
        if map_store.id in positions:
            by_type.setdefault(map_store.type, []).append(map_store)
    anchors = []
    for slot in ("cafe", "restaurant", "bar"):
        candidates = by_type.get(PLACEHOLDER_SHAPES[slot].store_type, [])
        nearest = _nearest(candidates, STATION_XZ, positions)
        if nearest is not None:
            anchors.append(Anchor(slot, nearest, f"the {slot} nearest the station"))
    clubs, takeaways = by_type.get("club", []), by_type.get("takeaway", [])
    return anchors + _club_and_takeaway(clubs, takeaways, positions)


def _club_and_takeaway(
    clubs: list[MapStore], takeaways: list[MapStore], positions: dict[str, tuple[float, float]]
) -> list[Anchor]:
    if clubs and takeaways:
        takeaway, club = min(
            ((t, c) for t in takeaways for c in clubs),
            key=lambda pair: (
                math.dist(positions[pair[0].id], positions[pair[1].id]),
                pair[0].id,
                pair[1].id,
            ),
        )
        metres = math.dist(positions[takeaway.id], positions[club.id])
        return [
            Anchor("club", club, f"the club nearest {takeaway.name}"),
            Anchor(
                "late-night takeaway",
                takeaway,
                f"the takeaway nearest a club ({club.name}, {metres:.0f} m)",
            ),
        ]
    anchors = []
    lone_club = _nearest(clubs, STATION_XZ, positions)
    if lone_club is not None:
        reason = "the club nearest the station (no takeaway in map)"
        anchors.append(Anchor("club", lone_club, reason))
    lone_takeaway = _nearest(takeaways, STATION_XZ, positions)
    if lone_takeaway is not None:
        reason = "the takeaway nearest the station (no club in map)"
        anchors.append(Anchor("late-night takeaway", lone_takeaway, reason))
    return anchors


def _store_positions(map_data: MapData) -> dict[str, tuple[float, float]]:
    """Store id -> building centre (x, z), for stores whose building is in the map."""
    centres = {b.id: (b.x, b.z) for b in map_data.buildings}
    return {s.id: centres[s.buildingId] for s in map_data.stores if s.buildingId in centres}


def _nearest(
    candidates: list[MapStore],
    point: tuple[float, float],
    positions: dict[str, tuple[float, float]],
) -> MapStore | None:
    return min(candidates, key=lambda s: (math.dist(positions[s.id], point), s.id), default=None)


# --- venues ---------------------------------------------------------------------------------


def placeholder_venue(anchor: Anchor) -> CalibrationVenue:
    """The labelled placeholder for an anchor: its venue type's typical shape, not measured."""
    shape = PLACEHOLDER_SHAPES[anchor.slot]
    return CalibrationVenue(
        name=f"Typical {anchor.slot}",
        storeId=anchor.store.id,
        type=anchor.store.type,
        weekday=_dense(shape.weekday),
        weekend=_dense(shape.weekend),
        measured=False,
        source=None,
    )


def _measured_venue(anchor: Anchor, name: str, week: Week, source: Source) -> CalibrationVenue:
    weekday, weekend = weekday_weekend(week)
    return CalibrationVenue(
        name=name,
        storeId=anchor.store.id,
        type=anchor.store.type,
        weekday=weekday,
        weekend=weekend,
        measured=True,
        source=source,
    )


def weekday_weekend(week: Week) -> tuple[list[float], list[float]]:
    """Mean busyness by clock hour over the Mon-Fri and the Sat-Sun calendar days."""
    weekdays = [day for day in range(7) if day not in WEEKEND]

    def mean(days: Sequence[int], hour: int) -> float:
        return round(sum(week[day][hour] for day in days) / len(days), 1)

    return [mean(weekdays, h) for h in range(24)], [mean(WEEKEND, h) for h in range(24)]


def names_match(a: str, b: str) -> bool:
    """True when two venue names refer to the same place: the same words once filler words are
    dropped, or a name of 2+ words contained in the other ("Ozone Coffee" ~ "Ozone Coffee
    Roasters"). Strict on purpose: another venue's real data is worse than a placeholder."""
    small, large = sorted((_name_words(a), _name_words(b)), key=len)
    if not small:
        return False
    return small == large or (len(small) >= 2 and small <= large)


def _name_words(name: str) -> frozenset[str]:
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return frozenset(re.findall(r"[a-z0-9]+", plain)) - NAME_STOPWORDS


def _require_same_venue(found: str, map_store: MapStore) -> None:
    if not names_match(found, map_store.name):
        raise ProviderDataError(f"found {found!r}, not {map_store.name!r}")


def _dense(sparse: dict[int, float]) -> list[float]:
    return [float(sparse.get(hour, 0)) for hour in range(24)]


def _empty_week() -> Week:
    return [[0.0] * 24 for _ in range(7)]


def _is_percentage(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and 0 <= value <= 100


# --- BestTime -------------------------------------------------------------------------------


def besttime_venue(anchor: Anchor, api_key: str) -> CalibrationVenue:
    """Measured venue from a BestTime "new foot traffic forecast" for the anchor store.

    POST /api/v1/forecasts with venue_name + venue_address (2 credits on success, 1 on failure;
    https://documentation.besttime.app). The response is cached in data/raw/besttime/.
    """
    body, fetched_at = _fetch_with_secret(
        "besttime",
        BESTTIME_FORECAST_URL,
        method="POST",
        params={"venue_name": anchor.store.name, "venue_address": VENUE_AREA},
        secret={"api_key_private": api_key},
    )
    week = besttime_week(body)
    info = body.get("venue_info")
    info = info if isinstance(info, dict) else {}
    name = str(info.get("venue_name") or "")
    _require_same_venue(name, anchor.store)
    address = str(info.get("venue_address") or "")
    label = f"BestTime foot-traffic forecast: {name}" + (f", {address}" if address else "")
    source = common.cite(label, "https://besttime.app", fetched_at)
    return _measured_venue(anchor, name, week, source)


def besttime_week(body: Any) -> Week:
    """Calendar week from a BestTime forecast response.

    `analysis` holds one entry per weekday (day_info.day_int 0 = Monday). Its day_raw is a
    "BestTime day" from 06:00 to 05:00, so the values from midnight on go to the next day.
    """
    if not isinstance(body, dict) or body.get("status") != "OK":
        detail = body.get("message") if isinstance(body, dict) else None
        raise ProviderDataError(f"forecast status is not OK ({detail or 'no message'})")
    analysis = body.get("analysis")
    if not isinstance(analysis, list) or len(analysis) != 7:
        raise ProviderDataError("forecast has no 7-day analysis")
    week = _empty_week()
    for position, day in enumerate(analysis):
        if not isinstance(day, dict):
            raise ProviderDataError("forecast day is not an object")
        info = day.get("day_info")
        day_int = info.get("day_int", position) if isinstance(info, dict) else position
        if not isinstance(day_int, int) or not 0 <= day_int <= 6:
            raise ProviderDataError(f"forecast day_int {day_int!r} outside 0..6")
        raw = day.get("day_raw")
        if not isinstance(raw, list) or len(raw) != 24 or not all(map(_is_percentage, raw)):
            raise ProviderDataError("forecast day_raw is not 24 values in 0..100")
        for index, value in enumerate(raw):
            clock = BESTTIME_DAY_START_HOUR + index
            week[(day_int + clock // 24) % 7][clock % 24] = float(value)
    return week


def _fetch_with_secret(
    source: str, url: str, *, method: str, params: dict[str, str], secret: dict[str, str]
) -> tuple[Any, str]:
    """common.fetch for an API whose key must be a query parameter (BestTime).

    The key is sent but kept out of the scrape-cache key and the raw file in data/raw/, and
    errors never echo the request URL, which carries it. Same cache policy as common.fetch.
    """
    key_params = {"params": params, "data": None, "method": method}
    cached = cache.scrape_get(source, url, key_params)
    if cached is not None:
        return cached["content"], cached["fetchedAt"]
    try:
        response = httpx.request(
            method,
            url,
            params={**params, **secret},
            headers={"User-Agent": common.USER_AGENT},
            timeout=common.TIMEOUT,
            follow_redirects=True,
        )
    except httpx.HTTPError as e:
        raise common.FetchError(f"{source}: {method} {url} failed: {type(e).__name__}") from None
    try:
        body = response.json()
    except ValueError:
        body = None
    if response.is_error or body is None:
        detail = body.get("message") if isinstance(body, dict) else None
        raise common.FetchError(
            f"{source}: HTTP {response.status_code}" + (f": {detail}" if detail else "")
        )
    fetched_at = store.now_iso()
    cache.scrape_put(
        source, url, key_params, {"content": body, "fetchedAt": fetched_at}, fetched_at
    )
    return body, fetched_at


# --- Outscraper -----------------------------------------------------------------------------


def outscraper_venue(anchor: Anchor, api_key: str) -> CalibrationVenue:
    """Measured venue from Google Popular Times via Outscraper's Google Maps search.

    GET /google-maps-search, key in the X-API-KEY header, one place, synchronous
    (https://app.outscraper.cloud/api-docs). The response is cached in data/raw/outscraper/.
    """
    body, fetched_at = common.fetch(
        "outscraper",
        OUTSCRAPER_SEARCH_URL,
        params={
            "query": f"{anchor.store.name}, {VENUE_AREA}",
            "limit": "1",
            "async": "false",
            "language": "en",
            "region": "GB",
            "fields": "name,full_address,place_id,popular_times",
        },
        headers={"X-API-KEY": api_key},
    )
    place = _outscraper_place(body)
    name = str(place.get("name") or "")
    _require_same_venue(name, anchor.store)
    week = outscraper_week(place.get("popular_times"))
    query = name + (f", {place['full_address']}" if place.get("full_address") else "")
    url = "https://www.google.com/maps/search/?api=1&query=" + quote_plus(query)
    if place.get("place_id"):
        url += "&query_place_id=" + quote_plus(str(place["place_id"]))
    source = common.cite(f"Google Popular Times via Outscraper: {name}", url, fetched_at)
    return _measured_venue(anchor, name, week, source)


def _outscraper_place(body: Any) -> dict[str, Any]:
    """The first place in a google-maps-search response ({"data": [[place, ...]]})."""
    if not isinstance(body, dict):
        raise ProviderDataError("response is not a JSON object")
    if body.get("error"):
        raise ProviderDataError(f"error: {body.get('errorMessage') or 'no message'}")
    data = body.get("data")
    if not isinstance(data, list) or not data:
        raise ProviderDataError(f"no results (status {body.get('status')!r})")
    places = data[0] if isinstance(data[0], list) else data
    if not places or not isinstance(places[0], dict):
        raise ProviderDataError("no place found")
    return places[0]


def outscraper_week(popular_times: Any) -> Week:
    """Calendar week from Outscraper's popular_times.

    One entry per weekday ("day_text", or "day" 1 = Monday .. 7 = Sunday), each a list of
    {"hour", "percentage"} in Google's chart order. A day's chart runs past midnight, so the
    items after the hours wrap round belong to the next day. Entries without a weekday (the
    "live" reading) are skipped; a missing percentage counts as 0.
    """
    if not isinstance(popular_times, list):
        raise ProviderDataError("place has no popular_times")
    week = _empty_week()
    days = 0
    for entry in popular_times:
        weekday = _outscraper_weekday(entry)
        if weekday is None:
            continue
        days += 1
        # debt: the next-day rule is inferred from hour order; Outscraper's docs only show
        # popular_times as null. ceiling: a venue day listed 00-23 whose 00-05 are the night
        # after would land those hours a day early. upgrade: check the first keyed response in
        # data/raw/outscraper/ before trusting after-midnight hours.
        wrapped, previous = False, -1
        for item in entry.get("popular_times") or []:
            hour = item.get("hour") if isinstance(item, dict) else None
            value = (item.get("percentage") if isinstance(item, dict) else None) or 0
            if not isinstance(hour, int) or not 0 <= hour <= 23 or not _is_percentage(value):
                raise ProviderDataError("popular_times item needs hour 0..23, percentage 0..100")
            wrapped = wrapped or hour < previous
            previous = hour
            week[(weekday + int(wrapped)) % 7][hour] = float(value)
    if days == 0:
        raise ProviderDataError("popular_times has no weekday entries")
    return week


def _outscraper_weekday(entry: Any) -> int | None:
    if not isinstance(entry, dict):
        return None
    text = entry.get("day_text")
    if isinstance(text, str) and text.lower() in WEEKDAY_NAMES:
        return WEEKDAY_NAMES.index(text.lower())
    day = entry.get("day")
    if isinstance(day, int) and not isinstance(day, bool) and 1 <= day <= 7:
        return day - 1
    return None


def main() -> None:
    calibration = build()
    print(f"calibration.json: {len(calibration.venues)} venues, fallback={calibration.fallback}")
    for venue in calibration.venues:
        store_id = venue.storeId or "-"
        print(f"  {store_id:<6} {venue.type:<10} measured={venue.measured!s:<5} {venue.name}")


if __name__ == "__main__":
    main()

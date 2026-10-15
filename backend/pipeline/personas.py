"""personas.json: about ten anonymous visitor archetypes for the Shoreditch sim.

Each archetype says who arrives (share, entryKinds), when (activeHours, weekendMultiplier), what
they visit (storePrefs, stopsPerTrip, dwellMinutes), how strongly a lit shopfront after dark draws
them in (lightingSensitivity) and whether they come back (returningProb).

Two paths, one output (schemas.PersonasFile):
  llm      llm.available() and texts were collected: settings.PERSONA_MODEL revises the
           hand-written archetypes from those texts (structured outputs, LLM response cache).
           fallback=False.
  offline  otherwise: the hand-written ARCHETYPES below, cited to public sources. fallback=True.

Sources and access (checked 2026-10-15):
  Reddit r/london, r/AskLondon, r/londonsocialclub: PRAW, needs REDDIT_CLIENT_ID and
    REDDIT_CLIENT_SECRET; collected only when both are set and an LLM can summarise the posts.
  Google Maps, Yelp, TripAdvisor reviews: their terms forbid scraping, so nothing is collected.
  Time Out London Shoreditch guides: public pages that robots.txt (updated 2026-03-04) allows;
    three pages, fetched once into the scrape cache.
  ONS Time Use and TfL open data: cited for daily timing; not fetched.

Privacy: the processed file holds anonymous archetypes and source links only. Usernames are never
collected; raw texts stay in data/raw/ (gitignored).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, get_args
from urllib.parse import quote
from urllib.robotparser import RobotFileParser

import anthropic

from backend import cache, llm, settings, store
from backend.contract import EntryKind, Source, StoreType
from backend.pipeline import common
from backend.schemas import Persona, PersonasFile
from backend.store import now_iso

STEP = "personas"
AGENT = "persona-builder"
STORE_TYPES: tuple[StoreType, ...] = get_args(StoreType)
ENTRY_KINDS: tuple[EntryKind, ...] = get_args(EntryKind)

ONS_TIME_USE = common.cite(
    "ONS Time Use in the UK: daily routines (paid work, meals, travel, socialising)",
    "https://www.ons.gov.uk/peoplepopulationandcommunity/personalandhouseholdfinances/"
    "incomeandwealth/bulletins/timeuseintheuk/latest",
)
TFL_OPEN_DATA = common.cite(
    "TfL open data: station entries/exits and night services",
    "https://tfl.gov.uk/info-for/open-data-users/",
)

# --- hand-written archetypes (the offline path, and the LLM's starting point) ----------------

# Typical dwell per store type in minutes (min, max); archetypes override where they differ.
DEFAULT_DWELL: dict[StoreType, tuple[int, int]] = {
    "cafe": (10, 30),
    "restaurant": (45, 90),
    "takeaway": (3, 10),
    "bar": (30, 90),
    "shop": (5, 20),
    "offlicence": (2, 8),
    "club": (90, 240),
}


@dataclass(frozen=True)
class Archetype:
    """A hand-written archetype. `hours` holds sparse relative weights; build() normalises them."""

    id: str
    label: str
    share: float
    returning_prob: float
    hours: dict[int, float]
    weekend_multiplier: float
    store_prefs: dict[StoreType, float]
    lighting_sensitivity: float
    stops_per_trip: tuple[float, float]
    entry_kinds: dict[EntryKind, float]
    basis: str  # what the numbers are based on; copied into the file's notes
    dwell: dict[StoreType, tuple[int, int]] = field(default_factory=dict)
    evidence: tuple[Source, ...] = (ONS_TIME_USE,)


# One row per field keeps the archetypes comparable at a glance; the formatter would split every
# dict into one entry per line.
# fmt: off
ARCHETYPES: tuple[Archetype, ...] = (
    Archetype(
        id="morning-commuter",
        label="Morning commuter",
        share=0.14,
        returning_prob=0.85,
        hours={6: 1.5, 7: 6, 8: 10, 9: 5, 10: 1, 16: 1.5, 17: 5, 18: 6, 19: 2.5, 20: 0.8},
        weekend_multiplier=0.25,
        store_prefs={
            "cafe": 1.0, "restaurant": 0.05, "takeaway": 0.5, "bar": 0.05,
            "shop": 0.3, "offlicence": 0.15, "club": 0.0,
        },
        lighting_sensitivity=0.25,
        stops_per_trip=(0, 1),
        entry_kinds={"station": 0.85, "street": 0.15},
        dwell={"cafe": (3, 10), "takeaway": (2, 6), "shop": (2, 8)},
        evidence=(TFL_OPEN_DATA, ONS_TIME_USE),
        basis="weekday rail peaks 07-09 and 17-19 through Shoreditch High St (TfL); coffee to "
        "go, often no stop at all; weekdays only, so weekend 0.25",
    ),
    Archetype(
        id="office-worker",
        label="Office worker",
        share=0.16,
        returning_prob=0.85,
        hours={
            7: 0.5, 8: 2.5, 9: 2, 10: 1, 11: 2, 12: 9, 13: 10, 14: 4,
            15: 2, 16: 2, 17: 5, 18: 4.5, 19: 2, 20: 0.8, 21: 0.3,
        },
        weekend_multiplier=0.15,
        store_prefs={
            "cafe": 0.8, "restaurant": 0.7, "takeaway": 0.8, "bar": 0.5,
            "shop": 0.4, "offlicence": 0.1, "club": 0.0,
        },
        lighting_sensitivity=0.3,
        stops_per_trip=(1, 2),
        entry_kinds={"station": 0.6, "street": 0.4},
        dwell={"cafe": (5, 20), "restaurant": (30, 60), "bar": (45, 120)},
        evidence=(ONS_TIME_USE, TFL_OPEN_DATA),
        basis="works in the area's offices: lunch peak 12-14 and after-work 17-19 (ONS daily "
        "routines); the same routine every weekday, so returning 0.85",
    ),
    Archetype(
        id="remote-worker",
        label="Remote worker",
        share=0.06,
        returning_prob=0.6,
        hours={
            7: 0.2, 8: 1.5, 9: 5, 10: 8, 11: 7, 12: 6, 13: 6, 14: 6,
            15: 5, 16: 3, 17: 1.5, 18: 0.7, 19: 0.3,
        },
        weekend_multiplier=0.5,
        store_prefs={
            "cafe": 1.0, "restaurant": 0.4, "takeaway": 0.4, "bar": 0.15,
            "shop": 0.25, "offlicence": 0.1, "club": 0.0,
        },
        lighting_sensitivity=0.2,
        stops_per_trip=(1, 2),
        entry_kinds={"street": 0.6, "station": 0.4},
        dwell={"cafe": (60, 180), "restaurant": (30, 60)},
        basis="laptop workers in cafes 09-17 with long dwell (Time Out: a late-night bar serves "
        "them breakfast from 8am; a pay-by-the-hour venue runs 8am-6pm); daytime, so lighting "
        "barely matters",
    ),
    Archetype(
        id="local-resident",
        label="Local resident",
        share=0.11,
        returning_prob=0.95,
        hours={
            0: 0.3, 1: 0.1, 6: 0.2, 7: 1.5, 8: 2, 9: 1.5, 10: 1.5, 11: 2, 12: 2.5,
            13: 2.5, 14: 2, 15: 2, 16: 3, 17: 6, 18: 9, 19: 10, 20: 8, 21: 5, 22: 3, 23: 1.2,
        },
        weekend_multiplier=1.3,
        store_prefs={
            "cafe": 0.4, "restaurant": 0.3, "takeaway": 0.5, "bar": 0.3,
            "shop": 0.8, "offlicence": 1.0, "club": 0.05,
        },
        lighting_sensitivity=0.3,
        stops_per_trip=(1, 2),
        entry_kinds={"street": 0.9, "station": 0.1},
        dwell={"shop": (5, 15), "offlicence": (2, 6)},
        basis="lives nearby and walks in: evening grocery and off-licence runs 17-21, more at "
        "weekends; habit over lights; the most regular group",
    ),
    Archetype(
        id="tourist",
        label="Tourist / day-tripper",
        share=0.11,
        returning_prob=0.02,
        hours={
            8: 0.3, 9: 1.5, 10: 4, 11: 7, 12: 9, 13: 10, 14: 10, 15: 9, 16: 7,
            17: 5, 18: 3.5, 19: 2.5, 20: 1.5, 21: 1, 22: 0.4, 23: 0.1,
        },
        weekend_multiplier=1.8,
        store_prefs={
            "cafe": 0.7, "restaurant": 0.8, "takeaway": 0.4, "bar": 0.6,
            "shop": 0.9, "offlicence": 0.1, "club": 0.1,
        },
        lighting_sensitivity=0.6,
        stops_per_trip=(2, 4),
        entry_kinds={"station": 0.7, "street": 0.3},
        dwell={"cafe": (15, 45), "restaurant": (60, 105), "shop": (10, 30), "bar": (30, 75)},
        basis="visitors for markets, museums, galleries and food 10-19 (Time Out area guide), "
        "busiest at weekends; one-off (0.02 covers multi-night hotel stays); a lit front "
        "signals open to strangers",
    ),
    Archetype(
        id="weekend-shopper",
        label="Weekend shopper",
        share=0.05,
        returning_prob=0.2,
        hours={
            9: 0.5, 10: 3, 11: 6, 12: 9, 13: 10, 14: 10, 15: 9, 16: 7,
            17: 4.5, 18: 2, 19: 0.8, 20: 0.2,
        },
        weekend_multiplier=3.5,
        store_prefs={
            "cafe": 0.7, "restaurant": 0.5, "takeaway": 0.3, "bar": 0.3,
            "shop": 1.0, "offlicence": 0.1, "club": 0.0,
        },
        lighting_sensitivity=0.4,
        stops_per_trip=(2, 4),
        entry_kinds={"station": 0.6, "street": 0.4},
        dwell={"shop": (10, 40), "cafe": (15, 40)},
        basis="Londoners at markets and independent shops 10-17, mostly Sat/Sun (Time Out: "
        "Columbia Road flower market Sundays 8am-3pm, Brick Lane Market); several shops plus "
        "a cafe",
    ),
    Archetype(
        id="after-work-drinker",
        label="After-work drinker",
        share=0.09,
        returning_prob=0.55,
        hours={15: 0.3, 16: 1, 17: 5, 18: 9, 19: 10, 20: 8, 21: 5.5, 22: 3, 23: 1.5, 0: 0.4},
        weekend_multiplier=0.9,
        store_prefs={
            "cafe": 0.05, "restaurant": 0.4, "takeaway": 0.5, "bar": 1.0,
            "shop": 0.05, "offlicence": 0.3, "club": 0.15,
        },
        lighting_sensitivity=0.6,
        stops_per_trip=(1, 3),
        entry_kinds={"station": 0.5, "street": 0.5},
        dwell={"bar": (45, 150), "restaurant": (40, 80)},
        basis="office crowd in bars 17-23 (Time Out: a 5-8pm happy hour; a pub that fills with "
        "nearby tech workers from 7pm); bar first, takeaway later; regular haunts, so "
        "returning 0.55",
    ),
    Archetype(
        id="evening-diner",
        label="Evening diner",
        share=0.08,
        returning_prob=0.3,
        hours={12: 0.8, 13: 0.8, 17: 2, 18: 6, 19: 10, 20: 9, 21: 5, 22: 2, 23: 0.6},
        weekend_multiplier=1.4,
        store_prefs={
            "cafe": 0.1, "restaurant": 1.0, "takeaway": 0.2, "bar": 0.6,
            "shop": 0.05, "offlicence": 0.1, "club": 0.05,
        },
        lighting_sensitivity=0.5,
        stops_per_trip=(1, 2),
        entry_kinds={"station": 0.55, "street": 0.45},
        dwell={"restaurant": (60, 120), "bar": (30, 75)},
        basis="dinner 18-22 with a drink before or after (the Time Out area guide lists "
        "destination restaurants); more at weekends; occasional repeat visits",
    ),
    Archetype(
        id="night-owl",
        label="Night owl (clubber)",
        share=0.09,
        returning_prob=0.35,
        hours={19: 0.3, 20: 1, 21: 3, 22: 7, 23: 10, 0: 9, 1: 6, 2: 3, 3: 1, 4: 0.3},
        weekend_multiplier=2.5,
        store_prefs={
            "cafe": 0.05, "restaurant": 0.15, "takeaway": 0.9, "bar": 0.7,
            "shop": 0.05, "offlicence": 0.6, "club": 1.0,
        },
        lighting_sensitivity=0.9,
        stops_per_trip=(1, 3),
        entry_kinds={"station": 0.6, "street": 0.4},
        dwell={"club": (120, 300), "bar": (30, 90), "takeaway": (5, 15), "offlicence": (2, 6)},
        evidence=(TFL_OPEN_DATA, ONS_TIME_USE),
        basis="club-goers arriving 21-02, busiest at weekends (Time Out: XOYO draws crowds every "
        "weekend; late-night bars and a pub-club with a late licence); Fri/Sat night trains "
        "(TfL); pre-drinks, the club, then late food (takeaway 0.9); drawn to lit, open fronts",
    ),
    Archetype(
        id="late-shift-worker",
        label="Late-shift worker",
        share=0.04,
        returning_prob=0.8,
        hours={
            20: 0.5, 21: 1.5, 22: 4, 23: 8, 0: 10, 1: 7, 2: 4, 3: 2,
            4: 1.5, 5: 3, 6: 4, 7: 2, 8: 0.5,
        },
        weekend_multiplier=1.1,
        store_prefs={
            "cafe": 0.5, "restaurant": 0.1, "takeaway": 1.0, "bar": 0.15,
            "shop": 0.3, "offlicence": 0.7, "club": 0.0,
        },
        lighting_sensitivity=0.7,
        stops_per_trip=(0, 1),
        entry_kinds={"street": 0.7, "station": 0.3},
        dwell={"takeaway": (3, 12), "cafe": (5, 20), "offlicence": (2, 6)},
        evidence=(TFL_OPEN_DATA, ONS_TIME_USE),
        basis="hospitality, cleaning and care staff finishing 22-02 or starting 05-07; quick "
        "food on the way home by night bus; regular shifts, so returning 0.8",
    ),
    Archetype(
        id="student-creative",
        label="Student / creative",
        share=0.07,
        returning_prob=0.5,
        hours={
            9: 0.5, 10: 1, 11: 3, 12: 4.5, 13: 5, 14: 5, 15: 4.5, 16: 4, 17: 4.5,
            18: 5, 19: 5.5, 20: 6, 21: 6, 22: 5, 23: 3.5, 0: 2, 1: 1, 2: 0.4,
        },
        weekend_multiplier=1.2,
        store_prefs={
            "cafe": 0.9, "restaurant": 0.35, "takeaway": 0.7, "bar": 0.8,
            "shop": 0.5, "offlicence": 0.5, "club": 0.2,
        },
        lighting_sensitivity=0.5,
        stops_per_trip=(1, 3),
        entry_kinds={"street": 0.6, "station": 0.4},
        dwell={"cafe": (30, 120), "bar": (45, 120)},
        basis="art and design students and studio workers on loose hours 11-01 (Time Out area "
        "guide: galleries, gig venues, arty pubs); cheap cafes, bars and takeaways; half are "
        "regulars",
    ),
)
# fmt: on

# --- sources -----------------------------------------------------------------------------------

TIMEOUT_ROBOTS_URL = "https://www.timeout.com/robots.txt"


@dataclass(frozen=True)
class GuidePage:
    label: str
    url: str
    personas: tuple[str, ...]  # archetype ids the page is offline evidence for


# urllib.robotparser ignores "*" wildcards inside paths, so these URLs were also checked by
# hand against Time Out's wildcard rules (search, user, rss, ajax, bookings) on 2026-10-15.
TIMEOUT_PAGES: tuple[GuidePage, ...] = (
    GuidePage(
        "Time Out London: the 20 best things to do in Shoreditch",
        "https://www.timeout.com/london/things-to-do/shoreditch-area-guide",
        ("tourist", "weekend-shopper", "evening-diner", "student-creative", "night-owl"),
    ),
    GuidePage(
        "Time Out London: the best bars in Shoreditch",
        "https://www.timeout.com/london/bars-pubs/shoreditch-bars",
        ("after-work-drinker", "night-owl", "student-creative"),
    ),
    GuidePage(
        "Time Out London: 10 best clubs and nightlife venues in Shoreditch",
        "https://www.timeout.com/london/clubs-nightlife/shoreditch-clubs",
        ("night-owl", "after-work-drinker", "remote-worker"),
    ),
)

SUBREDDITS = ("london", "AskLondon", "londonsocialclub")
REDDIT_QUERY = "Shoreditch"
REDDIT_SEARCH: dict[str, Any] = {"sort": "relevance", "time_filter": "year", "limit": 50}
REDDIT_COMMENTS_PER_POST = 5

# Caps keep one long post or page from crowding the rest out of the prompt.
MAX_POST_CHARS = 1500
MAX_COMMENT_CHARS = 500
MAX_DOCUMENT_CHARS = 40_000

REVIEWS_NOTE = (
    "Google Maps, Yelp and TripAdvisor reviews: not collected; their terms of use forbid scraping."
)
TIMING_NOTE = (
    "ONS Time Use and TfL open data: cited as the public basis for daily timing (work and meal "
    "times, rail peaks, Friday/Saturday night trains); not fetched or fitted."
)
FIELD_NOTES = (
    "share = share of weekday arrivals into the area; on Sat/Sun weight it by "
    "weekendMultiplier and renormalise.",
    "activeHours = arrival weight by clock hour, normalised to sum 1 for each persona.",
    "weekendMultiplier applies to Sat/Sun clock days, so Friday-night hours after midnight "
    "count as Saturday.",
)
OFFLINE_NOTES = (
    "The numbers are the builder's judgement, informed by facts in the cited pages: Time Out "
    "for the venue mix and opening patterns, ONS Time Use and TfL for daily timing.",
    "returningProb is high for daily routines (residents, commuters, office and shift workers) "
    "and ~0 for tourists; lightingSensitivity is highest for night-time and unfamiliar "
    "visitors; storePrefs, stopsPerTrip, dwellMinutes and entryKinds are per-archetype "
    "judgement.",
)

# Bounds applied to LLM output; the hand-written archetypes sit well inside them.
MIN_SHARE = 0.005  # keeps every archetype id alive in the sim and on the frontend legend
MAX_WEEKEND_MULTIPLIER = 5.0
MAX_STOPS_PER_TRIP = 6
MAX_DWELL_MINUTES = 480


@dataclass(frozen=True)
class Document:
    """One collected text with its citation and the archetypes it is offline evidence for."""

    source: Source
    text: str
    personas: tuple[str, ...] = ()


# --- small helpers -----------------------------------------------------------------------------

_USERNAME = re.compile(r"(?<![\w/])/?u/[A-Za-z0-9_-]{2,}|(?<!\w)@[A-Za-z0-9_]{2,}")
_LINK_LABELS = re.compile(r"\b(?:Read more|Read review|Buy ticket|Book online)\b")


def scrub_usernames(text: str) -> str:
    """Replace Reddit-style u/name and @handle mentions with a placeholder (emails survive)."""
    return _USERNAME.sub("[user]", text)


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", _LINK_LABELS.sub(" ", text)).strip()


def sum_to_one(values: Sequence[float], digits: int = 4) -> list[float]:
    """Scale non-negative weights to sum 1, rounded, with the rounding residual on the largest."""
    total = sum(values)
    if total <= 0 or min(values) < 0:
        raise ValueError(f"weights must be non-negative with a positive sum, got {list(values)}")
    scaled = [round(v / total, digits) for v in values]
    largest = max(range(len(scaled)), key=scaled.__getitem__)
    scaled[largest] = round(scaled[largest] + 1.0 - sum(scaled), digits + 2)
    return scaled


def _clamp(value: Any, low: float, high: float) -> float:
    return min(high, max(low, float(value)))


def _returning_note(personas: Sequence[Persona]) -> str:
    implied = sum(p.share * p.returningProb for p in personas)
    return (
        f"Implied returning share of weekday arrivals (sum of share x returningProb): "
        f"{implied:.2f}."
    )


@contextmanager
def _refresh_policy(refresh: bool) -> Iterator[None]:
    """Honour build(refresh=True) without leaving the global scrape-cache policy changed."""
    previous = cache.policy.refresh
    cache.set_policy(refresh=previous or refresh)
    try:
        yield
    finally:
        cache.set_policy(refresh=previous)


# --- Time Out ----------------------------------------------------------------------------------


class _ArticleText(HTMLParser):
    """Collects a listing page's <h1> and the text of each top-level <article> (a venue tile)."""

    _SKIP = frozenset({"script", "style", "noscript", "svg", "picture", "form"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: list[str] = []
        self.articles: list[str] = []
        self._chunks: list[str] = []
        self._skip_depth = 0
        self._article_depth = 0
        self._h1_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag == "article":
            if self._article_depth == 0:
                self._chunks = []
            self._article_depth += 1
        elif tag == "h1":
            self._h1_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "article" and self._article_depth:
            self._article_depth -= 1
            if self._article_depth == 0:
                self.articles.append(_squash(" ".join(self._chunks)))
        elif tag == "h1":
            self._h1_depth = max(0, self._h1_depth - 1)

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._h1_depth:
            self.title.append(data)
        if self._article_depth:
            self._chunks.append(data)


def page_text(html: str) -> str:
    """Plain text of a Time Out listing page: its title, then one line per venue tile."""
    parser = _ArticleText()
    parser.feed(html)
    lines = [_squash(" ".join(parser.title))]
    size = len(lines[0])
    for article in parser.articles:
        if not article:
            continue
        if size + len(article) > MAX_DOCUMENT_CHARS:
            break
        lines.append(f"- {article}")
        size += len(article)
    return "\n".join(lines)


def collect_timeout() -> tuple[list[Document], list[str]]:
    """Fetch the Time Out guide pages robots.txt allows (scrape-cached). Returns docs and notes."""
    try:
        robots, _ = common.fetch("timeout", TIMEOUT_ROBOTS_URL, as_json=False)
    except common.FetchError as e:
        return [], [f"Time Out London: robots.txt unreachable ({e}); no pages fetched or cited."]
    rules = RobotFileParser()
    rules.parse(robots.splitlines())
    documents: list[Document] = []
    notes: list[str] = []
    for page in TIMEOUT_PAGES:
        if not rules.can_fetch(common.USER_AGENT, page.url):
            notes.append(f"Time Out London: robots.txt disallows {page.url}; skipped.")
            continue
        try:
            html, fetched_at = common.fetch("timeout", page.url, as_json=False)
        except common.FetchError as e:
            notes.append(f"Time Out London: {page.url} failed ({e}); not cited.")
            continue
        source = common.cite(page.label, page.url, fetched_at)
        documents.append(Document(source=source, text=page_text(html), personas=page.personas))
    notes.insert(
        0,
        f"Time Out London: robots.txt checked; {len(documents)} of {len(TIMEOUT_PAGES)} "
        "Shoreditch guide pages fetched (scrape cache data/raw/timeout/) and cited.",
    )
    return documents, notes


# --- Reddit (PRAW) -----------------------------------------------------------------------------


def reddit_configured() -> bool:
    """True when both PRAW credentials are set. Reddit is never called otherwise."""
    return bool(os.getenv("REDDIT_CLIENT_ID") and os.getenv("REDDIT_CLIENT_SECRET"))


def _anonymous_post(submission: Any) -> dict[str, Any]:
    """The parts of a submission worth summarising. Author fields are never read."""
    submission.comment_sort = "top"
    submission.comments.replace_more(limit=0)
    replies = list(submission.comments)[:REDDIT_COMMENTS_PER_POST]
    return {
        "permalink": f"https://www.reddit.com{submission.permalink}",
        "created": int(submission.created_utc),
        "title": scrub_usernames(submission.title),
        "text": scrub_usernames(submission.selftext)[:MAX_POST_CHARS],
        "comments": [scrub_usernames(c.body)[:MAX_COMMENT_CHARS] for c in replies],
    }


def _posts_text(posts: list[dict[str, Any]]) -> tuple[str, int]:
    """Posts in relevance order until MAX_DOCUMENT_CHARS. Returns the text and the post count."""
    blocks: list[str] = []
    size = 0
    for post in posts:
        lines = [f"Post: {post['title']}", post["text"], *(f"Reply: {c}" for c in post["comments"])]
        block = "\n".join(line for line in lines if line).strip()
        if blocks and size + len(block) > MAX_DOCUMENT_CHARS:
            break
        blocks.append(block)
        size += len(block)
    return "\n\n".join(blocks), len(blocks)


def collect_reddit() -> list[Document]:
    """Search each subreddit for Shoreditch posts via PRAW (read-only); anonymised and cached.

    Needs reddit_configured(). Only titles, post text, top-level reply text and permalinks are
    kept (data/raw/reddit/); usernames are never read. The citation is the search URL, not posts.
    """
    import praw  # deferred: only needed once credentials exist

    reddit = praw.Reddit(
        client_id=os.environ["REDDIT_CLIENT_ID"],
        client_secret=os.environ["REDDIT_CLIENT_SECRET"],
        user_agent=common.USER_AGENT,
    )
    reddit.read_only = True
    documents: list[Document] = []
    for subreddit in SUBREDDITS:
        url = f"https://www.reddit.com/r/{subreddit}/search/?q={quote(REDDIT_QUERY)}&restrict_sr=1"
        cached = cache.scrape_get("reddit", url, REDDIT_SEARCH)
        if cached is None:
            results = reddit.subreddit(subreddit).search(REDDIT_QUERY, **REDDIT_SEARCH)
            cached = {"content": [_anonymous_post(s) for s in results], "fetchedAt": now_iso()}
            cache.scrape_put("reddit", url, REDDIT_SEARCH, cached, cached["fetchedAt"])
        text, used = _posts_text(cached["content"])
        label = f"Reddit r/{subreddit}: search '{REDDIT_QUERY}', past year ({used} posts)"
        documents.append(Document(source=common.cite(label, url, cached["fetchedAt"]), text=text))
    return documents


def collect_documents(use_llm: bool) -> tuple[list[Document], list[str]]:
    """Collect the texts personas are built from, plus one access note per source.

    Time Out pages are always collected (offline they are cited as evidence). Reddit is only
    collected when its credentials exist and an LLM can summarise the posts.
    """
    documents, notes = collect_timeout()
    if not reddit_configured():
        notes.append(
            "Reddit r/london, r/AskLondon, r/londonsocialclub: not collected; REDDIT_CLIENT_ID "
            "and REDDIT_CLIENT_SECRET are not set (the PRAW path runs once both are)."
        )
    elif not use_llm:
        notes.append(
            "Reddit: credentials are set, but posts are only used through LLM synthesis, which "
            "is unavailable; not collected."
        )
    else:
        from praw.exceptions import PRAWException
        from prawcore.exceptions import PrawcoreException

        try:
            reddit_documents = collect_reddit()
        except (PRAWException, PrawcoreException) as e:
            notes.append(f"Reddit: collection failed ({type(e).__name__}: {e}); not used.")
        else:
            documents += reddit_documents
            notes.append(
                f"Reddit: r/{', r/'.join(SUBREDDITS)} searched for '{REDDIT_QUERY}' (past year) "
                "via PRAW; anonymised posts summarised, usernames never collected."
            )
    return documents, notes


# --- offline path ------------------------------------------------------------------------------


def offline_personas(documents: Sequence[Document] = ()) -> list[Persona]:
    """The hand-written archetypes as Persona models, citing the documents that support them."""
    shares = sum_to_one([a.share for a in ARCHETYPES])
    return [
        Persona(
            id=a.id,
            label=a.label,
            share=share,
            returningProb=a.returning_prob,
            activeHours=sum_to_one([a.hours.get(h, 0.0) for h in range(24)]),
            weekendMultiplier=a.weekend_multiplier,
            storePrefs={t: a.store_prefs[t] for t in STORE_TYPES},
            lightingSensitivity=a.lighting_sensitivity,
            stopsPerTrip=a.stops_per_trip,
            dwellMinutes={t: a.dwell.get(t, DEFAULT_DWELL[t]) for t in STORE_TYPES},
            entryKinds=a.entry_kinds,
            evidence=[*a.evidence, *(d.source for d in documents if a.id in d.personas)],
        )
        for a, share in zip(ARCHETYPES, shares, strict=True)
    ]


def offline_file(
    documents: list[Document], access_notes: list[str], *, reason: str
) -> PersonasFile:
    """The hand-written archetypes as a fallback file; `reason` says why no LLM synthesis ran."""
    personas = offline_personas(documents)
    return PersonasFile(
        personas=personas,
        sources=[ONS_TIME_USE, TFL_OPEN_DATA, *(d.source for d in documents if d.personas)],
        fallback=True,
        notes=[
            f"fallback: no LLM synthesis ran ({reason}), so every archetype and number is "
            "hand-written in backend/pipeline/personas.py (ARCHETYPES); none is measured, and "
            "calibration should tune them.",
            *OFFLINE_NOTES,
            *access_notes,
            REVIEWS_NOTE,
            TIMING_NOTE,
            *FIELD_NOTES,
            _returning_note(personas),
            *(f"{a.id}: {a.basis}" for a in ARCHETYPES),
        ],
    )


# --- LLM path ----------------------------------------------------------------------------------


def _object(properties: dict[str, Any]) -> dict[str, Any]:
    """A structured-outputs object schema: every property required, nothing extra allowed."""
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


_NUMBER = {"type": "number"}
_MIN_MAX = _object({"min": {"type": "integer"}, "max": {"type": "integer"}})

# Structured outputs reject minimum/maximum and array-length keywords, so ranges are enforced in
# personas_from_llm; activeHours is an object with 24 required keys to guarantee every hour.
SYNTHESIS_SCHEMA = _object(
    {
        "personas": {
            "type": "array",
            "items": _object(
                {
                    "id": {"type": "string", "enum": [a.id for a in ARCHETYPES]},
                    "label": {"type": "string"},
                    "share": _NUMBER,
                    "returningProb": _NUMBER,
                    "activeHours": _object({f"h{h:02d}": _NUMBER for h in range(24)}),
                    "weekendMultiplier": _NUMBER,
                    "storePrefs": _object({t: _NUMBER for t in STORE_TYPES}),
                    "lightingSensitivity": _NUMBER,
                    "stopsPerTrip": _MIN_MAX,
                    "dwellMinutes": _object({t: _MIN_MAX for t in STORE_TYPES}),
                    "entryKinds": _object({k: _NUMBER for k in ENTRY_KINDS}),
                    "sourceIds": {"type": "array", "items": {"type": "integer"}},
                    "basis": {"type": "string"},
                }
            ),
        }
    }
)

SYNTHESIS_INSTRUCTIONS = """\
You turn public texts about Shoreditch, London into visitor archetypes for an agent-based \
simulation of the 500 m x 500 m area around Shoreditch High Street station. Independent store \
owners (cafes, restaurants, takeaways, bars, shops, off-licences) use the simulation to choose \
opening hours and shopfront lighting; clubs are fixed anchors.

You get hand-written starting archetypes and numbered documents. Return every starting \
archetype with its id, each value revised to match what the documents show about who comes to \
the area, when, and what they visit. Keep a starting value when the documents say nothing about \
it. Do not add groups the starting set lacks.

Fields:
- share: share of weekday arrivals into the area; shares sum to 1.
- returningProb: 0-1, chance that a member is a regular who comes back on several days of a \
fortnight.
- activeHours h00-h23: relative arrival weight by clock hour (h23 is 23:00-23:59).
- weekendMultiplier: arrival multiplier on Saturday and Sunday (1 = same as a weekday).
- storePrefs: 0-1 preference per store type (offlicence = off-licence or corner shop).
- lightingSensitivity: 0-1, how strongly a lit shopfront after dark draws them in.
- stopsPerTrip: min and max store visits on one trip into the area.
- dwellMinutes: min and max minutes per visit, per store type.
- entryKinds: relative weights for arriving on foot from the street or from a station.
- sourceIds: ids of the documents that support this archetype's values; empty when none do.
- basis: one sentence on what in the documents supports the values.

Privacy: describe groups, never individuals. Never include usernames, names of private people \
or quotes from posts."""


def _llm_view(persona: Persona, basis: str) -> dict[str, Any]:
    """A persona in SYNTHESIS_SCHEMA's shape: the starting point the model revises."""
    return {
        "id": persona.id,
        "label": persona.label,
        "share": persona.share,
        "returningProb": persona.returningProb,
        "activeHours": {f"h{h:02d}": w for h, w in enumerate(persona.activeHours)},
        "weekendMultiplier": persona.weekendMultiplier,
        "storePrefs": dict(persona.storePrefs),
        "lightingSensitivity": persona.lightingSensitivity,
        "stopsPerTrip": {
            "min": round(persona.stopsPerTrip[0]),
            "max": round(persona.stopsPerTrip[1]),
        },
        "dwellMinutes": {t: {"min": lo, "max": hi} for t, (lo, hi) in persona.dwellMinutes.items()},
        "entryKinds": dict(persona.entryKinds),
        "sourceIds": [],
        "basis": basis,
    }


def _documents_prompt(documents: Sequence[Document]) -> str:
    parts = [f"[{i}] {d.source.label} ({d.source.url})\n{d.text}" for i, d in enumerate(documents)]
    return "Documents:\n\n" + "\n\n".join(parts) + "\n\nRevise the starting archetypes."


def _dwell_range(value: dict[str, Any]) -> tuple[int, int]:
    low = round(_clamp(value["min"], 1, MAX_DWELL_MINUTES))
    return low, round(_clamp(value["max"], low, MAX_DWELL_MINUTES))


def _cited_sources(source_ids: list[Any], documents: Sequence[Document]) -> list[Source]:
    cited: list[Source] = []
    for i in source_ids:
        if isinstance(i, int) and 0 <= i < len(documents) and documents[i].source not in cited:
            cited.append(documents[i].source)
    return cited


def _persona_from_item(
    item: dict[str, Any], default: Persona, documents: Sequence[Document]
) -> Persona:
    hours = [max(0.0, float(item["activeHours"][f"h{h:02d}"])) for h in range(24)]
    entry = [max(0.0, float(item["entryKinds"][k])) for k in ENTRY_KINDS]
    stops_low = round(_clamp(item["stopsPerTrip"]["min"], 0, MAX_STOPS_PER_TRIP))
    stops_high = round(_clamp(item["stopsPerTrip"]["max"], stops_low, MAX_STOPS_PER_TRIP))
    return Persona(
        id=default.id,
        label=scrub_usernames(str(item["label"])).strip()[:60] or default.label,
        share=max(MIN_SHARE, float(item["share"])),
        returningProb=_clamp(item["returningProb"], 0.0, 1.0),
        activeHours=sum_to_one(hours) if sum(hours) > 0 else default.activeHours,
        weekendMultiplier=_clamp(item["weekendMultiplier"], 0.0, MAX_WEEKEND_MULTIPLIER),
        storePrefs={t: _clamp(item["storePrefs"][t], 0.0, 1.0) for t in STORE_TYPES},
        lightingSensitivity=_clamp(item["lightingSensitivity"], 0.0, 1.0),
        stopsPerTrip=(stops_low, stops_high),
        dwellMinutes={t: _dwell_range(item["dwellMinutes"][t]) for t in STORE_TYPES},
        entryKinds=(
            dict(zip(ENTRY_KINDS, sum_to_one(entry), strict=True))
            if sum(entry) > 0
            else default.entryKinds
        ),
        evidence=_cited_sources(item["sourceIds"], documents),
    )


def personas_from_llm(
    data: dict[str, Any], documents: Sequence[Document]
) -> tuple[list[Persona], list[str]]:
    """Clamp and renormalise a synthesis response into Persona models, plus one note each.

    Archetypes the response leaves out keep their hand-written values, and a note names them.
    Raises llm.LLMError when the response revises none of them.
    """
    defaults = {p.id: p for p in offline_personas(documents)}
    revised: dict[str, Persona] = {}
    notes: list[str] = []
    for item in data["personas"]:
        persona_id = item["id"]
        if persona_id in defaults and persona_id not in revised:
            revised[persona_id] = _persona_from_item(item, defaults[persona_id], documents)
            notes.append(f"{persona_id}: {scrub_usernames(str(item['basis'])).strip()}")
    if not revised:
        raise llm.LLMError(f"{AGENT}: the response revised none of the archetypes")
    kept = [persona_id for persona_id in defaults if persona_id not in revised]
    if kept:
        notes.append("Kept hand-written (missing from the model's answer): " + ", ".join(kept))
    personas = [revised.get(persona_id, default) for persona_id, default in defaults.items()]
    shares = sum_to_one([p.share for p in personas])
    personas = [p.model_copy(update={"share": s}) for p, s in zip(personas, shares, strict=True)]
    return personas, notes


def synthesise(documents: Sequence[Document]) -> tuple[list[Persona], list[str]]:
    """Ask settings.PERSONA_MODEL to revise the hand-written archetypes from the documents.

    Deterministic for the same documents, so the response is cached (llm.call_json
    cache_response). Raises llm.LLMError (or an anthropic.APIError) when no usable answer comes.
    """
    starting = [_llm_view(p, a.basis) for p, a in zip(offline_personas(), ARCHETYPES, strict=True)]
    data, _ = llm.call_json(
        agent=AGENT,
        model=settings.PERSONA_MODEL,
        system=llm.system_blocks(
            SYNTHESIS_INSTRUCTIONS, "Starting archetypes:\n" + json.dumps(starting, sort_keys=True)
        ),
        user=_documents_prompt(documents),
        schema=SYNTHESIS_SCHEMA,
        max_tokens=16000,
        cache_response=True,
    )
    try:
        return personas_from_llm(data, documents)
    except (KeyError, TypeError, ValueError) as e:
        raise llm.LLMError(f"{AGENT}: unusable synthesis response: {e!r}") from e


def synthesised_file(documents: list[Document], access_notes: list[str]) -> PersonasFile:
    """The LLM path. Falls back to the hand-written archetypes (fallback=True) when it can't run."""
    if not documents:
        return offline_file(documents, access_notes, reason="no texts were collected to summarise")
    try:
        personas, persona_notes = synthesise(documents)
    except (llm.LLMError, anthropic.APIError) as e:
        reason = f"LLM synthesis failed: {type(e).__name__}: {e}"[:300]
        return offline_file(documents, access_notes, reason=reason)
    return PersonasFile(
        personas=personas,
        sources=[ONS_TIME_USE, TFL_OPEN_DATA, *(d.source for d in documents)],
        fallback=False,
        notes=[
            f"LLM synthesis: {settings.PERSONA_MODEL} revised the hand-written archetypes from "
            f"{len(documents)} collected texts (structured outputs; response cached in "
            "data/cache/llm/).",
            "Model values are clamped to valid ranges; shares, activeHours and entryKinds are "
            "renormalised to sum 1.",
            *access_notes,
            REVIEWS_NOTE,
            TIMING_NOTE,
            *FIELD_NOTES,
            _returning_note(personas),
            *persona_notes,
        ],
    )


# --- pipeline step -----------------------------------------------------------------------------


def build(refresh: bool = False) -> PersonasFile:
    """Build data/processed/personas.json, or return it as is when no input changed.

    Inputs: this module's source (archetypes, prompt, normalisation), the model when Claude is
    available, Reddit credentials, and every collected text. refresh=True re-fetches and rebuilds.
    """
    with _refresh_policy(refresh):
        use_llm = llm.available()
        documents, access_notes = collect_documents(use_llm)
        inputs = {
            "code": cache.stable_hash(Path(__file__).read_text()),
            "model": settings.PERSONA_MODEL if use_llm else None,
            "reddit": reddit_configured(),
            "documents": [
                {
                    "url": d.source.url,
                    "fetchedAt": d.source.fetchedAt,
                    "text": cache.stable_hash(d.text),
                }
                for d in documents
            ],
        }
        if cache.pipeline_up_to_date(STEP, inputs):
            return store.load_personas()
        if use_llm:
            personas_file = synthesised_file(documents, access_notes)
        else:
            reason = "OFFLINE=1" if settings.OFFLINE else "no Claude API credentials"
            personas_file = offline_file(documents, access_notes, reason=reason)
        common.write_processed("personas.json", personas_file)
        # A fallback written while Claude was available is left unmarked so the next build
        # retries the synthesis instead of serving the fallback as up to date.
        if not (use_llm and personas_file.fallback):
            cache.pipeline_mark(STEP, inputs)
        return personas_file


def main() -> None:
    personas_file = build()
    mode = "hand-written fallback" if personas_file.fallback else settings.PERSONA_MODEL
    print(
        f"personas.json: {len(personas_file.personas)} personas ({mode}), "
        f"{len(personas_file.sources)} sources"
    )


if __name__ == "__main__":
    main()

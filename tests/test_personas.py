"""personas pipeline step: hand-written archetypes, Time Out and Reddit collection, LLM path.

No network: common.fetch, praw.Reddit and llm.call_json are replaced with fakes, and every data
directory points at tmp_path.
"""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import praw
import pytest
from prawcore.exceptions import PrawcoreException

from backend import cache, llm, settings
from backend.pipeline import common, personas
from backend.schemas import PersonasFile

FETCHED_AT = "2026-10-15T08:55:47Z"
ROBOTS_ALLOW_ALL = "User-agent: *\nDisallow: /search*\n"
LISTING_HTML = """<html><head><script>var tracking = 1;</script></head><body>
<h1>Shoreditch clubs</h1>
<form><p>Sign up for our newsletter</p></form>
<article><h3>XOYO</h3><p>Open late every weekend. Read more</p></article>
<article><h3>The Book Club</h3><p>Breakfast from 8am for laptop workers.</p></article>
</body></html>"""
SCHEMA_KEYWORDS_UNSUPPORTED = {"minimum", "maximum", "multipleOf", "minLength", "maxLength"}
SCHEMA_KEYWORDS_UNSUPPORTED |= {"minItems", "maxItems"}


@pytest.fixture
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Data dirs under tmp_path, no Claude, no Reddit credentials, default cache policy."""
    for name in ("PROCESSED_DIR", "RAW_DIR", "LLM_CACHE_DIR", "RUNS_DIR"):
        monkeypatch.setattr(settings, name, tmp_path / name.lower())
    monkeypatch.setattr(cache, "policy", cache.CachePolicy(disabled=False))
    monkeypatch.delenv("REDDIT_CLIENT_ID", raising=False)
    monkeypatch.delenv("REDDIT_CLIENT_SECRET", raising=False)
    monkeypatch.setattr(llm, "available", lambda: False)
    return tmp_path


def install_fetch(monkeypatch: pytest.MonkeyPatch, robots: str = ROBOTS_ALLOW_ALL) -> list[str]:
    """Serve `robots` and LISTING_HTML for Time Out URLs; returns the URLs requested, in order."""
    requested: list[str] = []

    def fetch(source: str, url: str, **kwargs: Any) -> tuple[str, str]:
        assert source == "timeout" and kwargs.get("as_json") is False
        requested.append(url)
        return (robots if url.endswith("/robots.txt") else LISTING_HTML), FETCHED_AT

    monkeypatch.setattr(common, "fetch", fetch)
    return requested


def assert_valid_personas_file(personas_file: PersonasFile) -> None:
    """The invariants every reader of personas.json relies on."""
    assert 9 <= len(personas_file.personas) <= 11
    ids = [p.id for p in personas_file.personas]
    assert len(set(ids)) == len(ids)
    assert all(re.fullmatch(r"[a-z]+(-[a-z]+)*", i) for i in ids)
    assert abs(sum(p.share for p in personas_file.personas) - 1.0) <= 1e-6
    assert personas_file.sources
    for p in personas_file.personas:
        assert set(p.storePrefs) == set(personas.STORE_TYPES)
        assert set(p.dwellMinutes) == set(personas.STORE_TYPES)
        assert all(0.0 <= v <= 1.0 for v in p.storePrefs.values())
        assert all(1 <= low <= high for low, high in p.dwellMinutes.values())
        assert len(p.activeHours) == 24 and min(p.activeHours) >= 0
        assert abs(sum(p.activeHours) - 1.0) <= 1e-6
        assert 0.0 <= p.returningProb <= 1.0
        assert 0.0 <= p.lightingSensitivity <= 1.0
        assert 0 <= p.stopsPerTrip[0] <= p.stopsPerTrip[1]
        assert p.weekendMultiplier >= 0
        assert set(p.entryKinds) <= {"street", "station"}
        assert abs(sum(p.entryKinds.values()) - 1.0) <= 1e-6


def starting_items() -> list[dict[str, Any]]:
    """The hand-written archetypes in the synthesis schema's shape, as a model would echo them."""
    return [
        personas._llm_view(p, a.basis)
        for p, a in zip(personas.offline_personas(), personas.ARCHETYPES, strict=True)
    ]


def fake_call_json(
    items: list[dict[str, Any]], captured: dict[str, Any] | None = None
) -> Callable[..., tuple[dict[str, Any], llm.Usage]]:
    def call_json(**kwargs: Any) -> tuple[dict[str, Any], llm.Usage]:
        if captured is not None:
            captured.update(kwargs)
        return {"personas": items}, llm.Usage()

    return call_json


# --- the committed file ------------------------------------------------------------------------


def test_committed_personas_json_satisfies_contract() -> None:
    data = json.loads((settings.PROCESSED_DIR / "personas.json").read_text())
    personas_file = PersonasFile.model_validate(data)
    assert_valid_personas_file(personas_file)
    if personas_file.fallback:
        assert any("no LLM synthesis ran" in n for n in personas_file.notes)


# --- offline path ------------------------------------------------------------------------------


def test_offline_build_writes_labelled_fallback(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requested = install_fetch(monkeypatch)
    personas_file = personas.build()

    assert_valid_personas_file(personas_file)
    assert personas_file.fallback is True
    on_disk = (settings.PROCESSED_DIR / "personas.json").read_text()
    assert PersonasFile.model_validate_json(on_disk) == personas_file
    assert requested[0] == personas.TIMEOUT_ROBOTS_URL
    cited = {s.url for s in personas_file.sources}
    assert {page.url for page in personas.TIMEOUT_PAGES} <= cited
    assert {personas.ONS_TIME_USE.url, personas.TFL_OPEN_DATA.url} <= cited
    assert all(p.evidence for p in personas_file.personas)
    notes = " ".join(personas_file.notes)
    assert "no LLM synthesis ran" in notes
    assert "REDDIT_CLIENT_ID" in notes
    assert "forbid scraping" in notes


def test_archetypes_cover_the_brief() -> None:
    by_id = {p.id: p for p in personas.offline_personas()}
    night = by_id["night-owl"]
    others = [p for p in by_id.values() if p.id != "night-owl"]

    assert night.storePrefs["club"] == 1.0
    assert max(p.storePrefs["club"] for p in others) <= 0.2
    assert night.lightingSensitivity == max(p.lightingSensitivity for p in by_id.values())
    assert night.storePrefs["takeaway"] >= 0.8
    assert sum(night.activeHours[h] for h in (21, 22, 23, 0, 1, 2, 3)) > 0.8
    assert by_id["tourist"].returningProb <= 0.05
    assert by_id["local-resident"].returningProb >= 0.8
    assert by_id["office-worker"].returningProb >= 0.8
    arrivals_by_hour = [sum(p.share * p.activeHours[h] for p in by_id.values()) for h in range(24)]
    assert min(arrivals_by_hour) > 0


def test_build_reuses_output_until_refresh(isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    install_fetch(monkeypatch)
    first = personas.build()
    rebuilds: list[str] = []

    def counting_offline_file(*args: Any, **kwargs: Any) -> PersonasFile:
        rebuilds.append(kwargs["reason"])
        return first

    monkeypatch.setattr(personas, "offline_file", counting_offline_file)
    assert personas.build() == first
    assert rebuilds == []
    personas.build(refresh=True)
    assert len(rebuilds) == 1
    assert cache.policy.refresh is False


def test_robots_disallow_skips_that_page(isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    requested = install_fetch(
        monkeypatch, robots="User-agent: *\nDisallow: /london/clubs-nightlife/\n"
    )
    clubs = personas.TIMEOUT_PAGES[2].url

    documents, notes = personas.collect_timeout()

    assert clubs not in requested
    assert [d.source.url for d in documents] == [
        page.url for page in personas.TIMEOUT_PAGES if page.url != clubs
    ]
    assert any("disallows" in n and clubs in n for n in notes)


def test_unreachable_time_out_still_builds(isolated: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_fetch(source: str, url: str, **kwargs: Any) -> tuple[str, str]:
        raise common.FetchError(f"{source}: GET {url} failed: offline")

    monkeypatch.setattr(common, "fetch", failing_fetch)
    personas_file = personas.build()

    assert_valid_personas_file(personas_file)
    assert personas_file.fallback is True
    assert {s.url for s in personas_file.sources} == {
        personas.ONS_TIME_USE.url,
        personas.TFL_OPEN_DATA.url,
    }
    assert any("robots.txt unreachable" in n for n in personas_file.notes)


def test_page_text_keeps_venue_tiles_only() -> None:
    text = personas.page_text(LISTING_HTML)

    assert text.splitlines()[0] == "Shoreditch clubs"
    assert "- XOYO Open late every weekend." in text
    assert "laptop workers" in text
    for dropped in ("tracking", "newsletter", "Read more"):
        assert dropped not in text


def test_scrub_usernames_keeps_emails() -> None:
    text = "thanks u/night_owl99 and /u/Bar-Fly, cc @shoreditchfan; mail a@b.com"
    assert personas.scrub_usernames(text) == "thanks [user] and [user], cc [user]; mail a@b.com"


def test_sum_to_one_rounds_and_rejects_bad_weights() -> None:
    thirds = personas.sum_to_one([1, 1, 1])
    assert thirds == pytest.approx([1 / 3] * 3, abs=1e-4)
    assert abs(sum(thirds) - 1.0) <= 1e-9
    with pytest.raises(ValueError):
        personas.sum_to_one([0, 0])
    with pytest.raises(ValueError):
        personas.sum_to_one([1, -1, 2])


def test_main_prints_summary(
    isolated: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    install_fetch(monkeypatch)
    personas.main()
    assert "11 personas (hand-written fallback)" in capsys.readouterr().out


# --- Reddit (PRAW, faked) ----------------------------------------------------------------------


class FakeComment:
    def __init__(self, body: str) -> None:
        self.body = body
        self.author = "commenter_handle"


class FakeComments:
    def __init__(self, bodies: list[str]) -> None:
        self._comments = [FakeComment(b) for b in bodies]

    def replace_more(self, limit: int) -> None:
        assert limit == 0  # never trigger extra "load more comments" requests

    def __iter__(self) -> Any:
        return iter(self._comments)


class FakeSubmission:
    author = "poster_handle"

    def __init__(self, n: int) -> None:
        self.permalink = f"/r/london/comments/abc{n}/late_food/"
        self.created_utc = 1_760_000_000.0 + n
        self.title = f"Late food near Shoreditch High St? ({n})"
        self.selftext = "Asking for after XOYO. Thanks u/poster_handle!"
        self.comments = FakeComments(
            ["The bagel shop on Brick Lane is 24h", "ask u/commenter_handle"]
        )
        self.comment_sort = "confidence"


def fake_reddit(searches: list[tuple[str, str, dict[str, Any]]], fail: bool = False) -> type:
    class FakeSubreddit:
        def __init__(self, name: str) -> None:
            self.name = name

        def search(self, query: str, **kwargs: Any) -> list[FakeSubmission]:
            if fail:
                raise PrawcoreException("received 401 HTTP response")
            searches.append((self.name, query, kwargs))
            return [FakeSubmission(1), FakeSubmission(2)]

    class FakeReddit:
        def __init__(self, **kwargs: Any) -> None:
            assert kwargs["client_id"] == "id" and kwargs["client_secret"] == "secret"
            self.read_only = False

        def subreddit(self, name: str) -> FakeSubreddit:
            return FakeSubreddit(name)

    return FakeReddit


def must_not_construct(**kwargs: Any) -> None:
    raise AssertionError("praw.Reddit must not be called")


def test_reddit_skipped_without_credentials(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fetch(monkeypatch)
    monkeypatch.setattr(praw, "Reddit", must_not_construct)

    documents, notes = personas.collect_documents(use_llm=True)

    assert all("reddit.com" not in d.source.url for d in documents)
    assert any("REDDIT_CLIENT_ID" in n and "not set" in n for n in notes)


def test_reddit_needs_an_llm_to_be_worth_collecting(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fetch(monkeypatch)
    monkeypatch.setenv("REDDIT_CLIENT_ID", "id")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "secret")
    monkeypatch.setattr(praw, "Reddit", must_not_construct)

    documents, notes = personas.collect_documents(use_llm=False)

    assert all("reddit.com" not in d.source.url for d in documents)
    assert any("only used through LLM synthesis" in n for n in notes)


def test_reddit_posts_are_anonymised_and_cached(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REDDIT_CLIENT_ID", "id")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "secret")
    searches: list[tuple[str, str, dict[str, Any]]] = []
    monkeypatch.setattr(praw, "Reddit", fake_reddit(searches))

    documents = personas.collect_reddit()

    assert [d.source.url for d in documents] == [
        f"https://www.reddit.com/r/{s}/search/?q=Shoreditch&restrict_sr=1"
        for s in personas.SUBREDDITS
    ]
    assert [(name, query) for name, query, _ in searches] == [
        (s, "Shoreditch") for s in personas.SUBREDDITS
    ]
    assert all(kwargs == personas.REDDIT_SEARCH for _, _, kwargs in searches)
    assert all("(2 posts)" in d.source.label and d.source.fetchedAt for d in documents)
    raw = "".join(p.read_text() for p in (settings.RAW_DIR / "reddit").glob("*.json"))
    for text in (*(d.text for d in documents), raw):
        assert "poster_handle" not in text
        assert "commenter_handle" not in text
    assert "bagel shop on Brick Lane" in documents[0].text
    assert "[user]" in documents[0].text

    personas.collect_reddit()
    assert len(searches) == len(personas.SUBREDDITS)


def test_reddit_failure_is_noted_not_raised(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fetch(monkeypatch)
    monkeypatch.setenv("REDDIT_CLIENT_ID", "id")
    monkeypatch.setenv("REDDIT_CLIENT_SECRET", "secret")
    monkeypatch.setattr(praw, "Reddit", fake_reddit([], fail=True))

    documents, notes = personas.collect_documents(use_llm=True)

    assert len(documents) == len(personas.TIMEOUT_PAGES)
    assert any("Reddit: collection failed (PrawcoreException" in n for n in notes)


# --- LLM path (llm.call_json faked) ------------------------------------------------------------


def test_llm_path_clamps_renormalises_and_cites(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fetch(monkeypatch)
    monkeypatch.setattr(llm, "available", lambda: True)
    items = copy.deepcopy(starting_items())
    for item in items:
        item["share"] *= 10
        item["sourceIds"] = [0, 99]
        item["basis"] = "Guide pages list late venues; thanks u/someone"
    night_item = next(i for i in items if i["id"] == "night-owl")
    night_item["storePrefs"]["club"] = 1.7
    night_item["lightingSensitivity"] = -0.2
    night_item["weekendMultiplier"] = 40
    night_item["dwellMinutes"]["club"] = {"min": 300, "max": 120}
    captured: dict[str, Any] = {}
    monkeypatch.setattr(llm, "call_json", fake_call_json(items, captured))

    personas_file = personas.build()

    assert personas_file.fallback is False
    assert_valid_personas_file(personas_file)
    assert captured["model"] == settings.PERSONA_MODEL
    assert captured["agent"] == personas.AGENT
    assert captured["cache_response"] is True
    assert captured["schema"] is personas.SYNTHESIS_SCHEMA
    assert "XOYO" in captured["user"]
    assert '"night-owl"' in captured["system"][-1]["text"]
    assert captured["system"][-1]["cache_control"] == {"type": "ephemeral"}
    night = next(p for p in personas_file.personas if p.id == "night-owl")
    assert night.storePrefs["club"] == 1.0
    assert night.lightingSensitivity == 0.0
    assert night.weekendMultiplier == personas.MAX_WEEKEND_MULTIPLIER
    assert night.dwellMinutes["club"] == (300, 300)
    assert [s.url for s in night.evidence] == [personas.TIMEOUT_PAGES[0].url]
    assert all("u/someone" not in n for n in personas_file.notes)
    assert any(settings.PERSONA_MODEL in n for n in personas_file.notes)


def test_llm_echoing_the_start_reproduces_the_archetypes() -> None:
    for persona, archetype in zip(personas.offline_personas(), personas.ARCHETYPES, strict=True):
        item = personas._llm_view(persona, archetype.basis)
        parsed = personas._persona_from_item(item, persona, [])
        assert parsed == persona.model_copy(update={"evidence": []})


def test_llm_partial_answer_keeps_missing_archetypes(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fetch(monkeypatch)
    monkeypatch.setattr(llm, "available", lambda: True)
    night_only = [i for i in starting_items() if i["id"] == "night-owl"]
    monkeypatch.setattr(llm, "call_json", fake_call_json(night_only))

    personas_file = personas.build()

    assert personas_file.fallback is False
    assert_valid_personas_file(personas_file)
    defaults = {p.id: p for p in personas.offline_personas()}
    tourist = next(p for p in personas_file.personas if p.id == "tourist")
    assert tourist.storePrefs == defaults["tourist"].storePrefs
    assert tourist.activeHours == defaults["tourist"].activeHours
    kept = next(n for n in personas_file.notes if n.startswith("Kept hand-written"))
    assert "tourist" in kept and "night-owl" not in kept


@pytest.mark.parametrize(
    "response",
    [{"personas": []}, {"personas": [{"id": "night-owl"}]}, {"unexpected": True}],
    ids=["empty", "missing-fields", "wrong-shape"],
)
def test_llm_unusable_response_falls_back(
    isolated: Path, monkeypatch: pytest.MonkeyPatch, response: dict[str, Any]
) -> None:
    install_fetch(monkeypatch)
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "call_json", lambda **kwargs: (response, llm.Usage()))

    personas_file = personas.build()

    assert personas_file.fallback is True
    assert_valid_personas_file(personas_file)
    assert any("LLM synthesis failed: LLMError" in n for n in personas_file.notes)


def test_llm_failure_falls_back_and_retries_next_build(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_fetch(monkeypatch)
    monkeypatch.setattr(llm, "available", lambda: True)
    calls: list[dict[str, Any]] = []

    def failing_call_json(**kwargs: Any) -> tuple[dict[str, Any], llm.Usage]:
        calls.append(kwargs)
        raise llm.BudgetExceeded("spend cap reached: $30.00 of $30.00")

    monkeypatch.setattr(llm, "call_json", failing_call_json)

    personas_file = personas.build()
    assert personas_file.fallback is True
    assert any("BudgetExceeded" in n for n in personas_file.notes)
    personas.build()
    assert len(calls) == 2


def test_llm_with_nothing_collected_uses_fallback(
    isolated: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def failing_fetch(source: str, url: str, **kwargs: Any) -> tuple[str, str]:
        raise common.FetchError("offline")

    monkeypatch.setattr(common, "fetch", failing_fetch)
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "call_json", fake_call_json(starting_items()))

    personas_file = personas.build()

    assert personas_file.fallback is True
    assert any("no texts were collected" in n for n in personas_file.notes)


def test_synthesis_schema_fits_structured_outputs() -> None:
    def walk(node: Any) -> None:
        if isinstance(node, dict):
            assert not SCHEMA_KEYWORDS_UNSUPPORTED & node.keys()
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert set(node["required"]) == set(node["properties"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(personas.SYNTHESIS_SCHEMA)
    item = personas.SYNTHESIS_SCHEMA["properties"]["personas"]["items"]
    assert len(item["properties"]["activeHours"]["required"]) == 24
    assert item["properties"]["id"]["enum"] == [a.id for a in personas.ARCHETYPES]

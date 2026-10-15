"""Every hard rule in backend/agents/rules.py, one test (or more) each."""

from __future__ import annotations

import json

import pytest

from backend import cache, settings
from backend.agents import rules
from backend.agents.changes import make_suggestion
from backend.contract import LightingLevel, MapData
from backend.schemas import StoreConfig

OFF: list[LightingLevel] = ["off"]
LOW: list[LightingLevel] = ["low"]
HIGH: list[LightingLevel] = ["high"]
LIGHTING = OFF * 7 + LOW * 10 + HIGH * 7  # 24 values


def _map() -> MapData:
    def store(sid, name, kind, licence=None):
        data = {"id": sid, "name": name, "type": kind, "buildingId": f"b-{sid}"}
        if licence:
            data["licensedHours"] = {"open": licence[0], "close": licence[1]}
        return data

    return MapData.model_validate(
        {
            "bounds": {"minX": -250, "maxX": 250, "minZ": -250, "maxZ": 250},
            "streets": [],
            "buildings": [],
            "stores": [
                store("s1", "Dawn Cafe", "cafe"),
                store("s2", "Kebab Co", "takeaway", ("06:00", "03:00")),
                store("s3", "Night Bar", "bar"),
                store("c1", "Club One", "club"),
            ],
            "entryPoints": [],
        }
    )


def _base() -> dict[str, StoreConfig]:
    return {
        "s1": StoreConfig(open="07:00", close="18:00", lighting=list(LIGHTING)),
        "s2": StoreConfig(open="11:00", close="23:00", lighting=list(LIGHTING)),
        "s3": StoreConfig(open="16:00", close="01:00", lighting=list(LIGHTING)),
        "c1": StoreConfig(open="22:00", close="03:00", lighting=list(LIGHTING)),
    }


def hours_change(store_id, field, from_, to):
    return make_suggestion(store_id, field, from_, to, visits=0.1, kwh=0.05)


def light(store_id, hours, from_, to):
    return make_suggestion(store_id, "lighting", from_, to, visits=0.0, kwh=-0.01, hours=hours)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_DIR", tmp_path / "runs")
    cache.set_policy(fresh=False)
    yield
    cache.set_policy(fresh=False)


def check(*suggestions, check_tried=True):
    return rules.check_changes(_base(), list(suggestions), _map(), check_tried=check_tried)


def only_reason(result) -> str:
    assert not result.accepted
    assert len(result.rejections) == 1
    return result.rejections[0].reason


def test_valid_close_extension_is_applied_and_base_untouched():
    base = _base()
    configs, rejections = rules.validate_changes(
        base, [hours_change("s2", "close", "23:00", "02:00")], _map()
    )
    assert rejections == []
    assert configs["s2"].close == "02:00"
    assert base["s2"].close == "23:00"
    assert configs["s1"] == base["s1"]


def test_times_must_be_on_the_30_minute_grid():
    assert "grid" in only_reason(check(hours_change("s2", "close", "23:00", "23:15")))
    assert check(hours_change("s2", "close", "23:00", "23:30")).accepted


@pytest.mark.parametrize("bad", ["25:00", "ab", "7", "07:60"])
def test_malformed_times_are_rejected(bad):
    assert only_reason(check(hours_change("s1", "close", "18:00", bad)))


def test_window_must_stay_inside_default_licence_cap():
    reason = only_reason(check(hours_change("s1", "close", "18:00", "23:30")))
    assert "licensed hours 06:00-23:00" in reason
    assert check(hours_change("s1", "close", "18:00", "20:00")).accepted
    assert only_reason(check(hours_change("s1", "open", "07:00", "05:30")))


def test_advice_never_stretches_a_day_past_the_type_cap():
    # a cafe trading 07:00-18:00 (11 h) may go to 13 h, not to 16 h even inside its licence
    assert check(hours_change("s1", "close", "18:00", "20:00")).accepted
    reason = only_reason(check(hours_change("s1", "close", "18:00", "23:00")))
    assert "longer than a cafe usually trades" in reason
    assert "13 h" in reason


def test_a_day_already_longer_than_the_cap_is_never_forced_shorter():
    # a takeaway already trading 20 h keeps that length: moving the window is still allowed
    base = _base()
    base["s2"] = StoreConfig(open="06:30", close="02:30", lighting=list(LIGHTING))
    result = rules.check_changes(
        base, [hours_change("s2", "open", "06:30", "07:00")], _map(), check_tried=False
    )
    assert result.accepted
    longer = rules.check_changes(
        base, [hours_change("s2", "open", "06:30", "06:00")], _map(), check_tried=False
    )
    assert "longer than a takeaway usually trades" in only_reason(longer)


def test_explicit_licensed_hours_override_the_type_default():
    # takeaways default to 06:00-04:00, but s2's licence in map.json ends at 03:00
    assert "licensed" in only_reason(check(hours_change("s2", "close", "23:00", "03:30")))
    assert check(hours_change("s2", "close", "23:00", "03:00")).accepted


def test_store_must_stay_open_at_least_60_minutes():
    reason = only_reason(check(hours_change("s1", "close", "18:00", "07:30")))
    assert "at least 60 min" in reason
    assert check(hours_change("s1", "close", "18:00", "08:00")).accepted


def test_store_must_close_for_at_least_30_minutes():
    # open == close means open 24 hours: no closed gap at all
    base = _base()
    base["s2"] = StoreConfig(open="06:00", close="23:00", lighting=list(LIGHTING))
    result = rules.check_changes(
        base, [hours_change("s2", "close", "23:00", "06:00")], _map(), check_tried=False
    )
    assert "close for at least 30 min" in only_reason(result)
    # an off-grid window can only come from data, but the gap rule still holds on its own
    assert "closed 15 min" in rules.hours_violation("06:00", "05:45", ("00:00", "00:00"))
    assert rules.hours_violation("06:00", "05:30", ("00:00", "00:00")) is None


def test_at_most_two_changes_per_store_per_week():
    result = check(
        hours_change("s2", "close", "23:00", "01:00"),
        light("s2", [22, 23], "high", "low"),
        hours_change("s2", "open", "11:00", "10:00"),
        hours_change("s1", "close", "18:00", "20:00"),
    )
    assert [s.storeId for s in result.accepted] == ["s2", "s2", "s1"]
    assert len(result.rejections) == 1
    assert "at most 2 changes" in result.rejections[0].reason
    assert result.rejections[0].suggestion.field == "open"


@pytest.mark.parametrize(
    ("hours", "from_", "to", "expected"),
    [
        ([20], "high", "medium", "lighting levels"),
        ([24], "off", "low", "0-23"),
        ([20, 20], "high", "low", "distinct"),
        ([], "high", "low", "at least one hour"),
        ([20], "high", "high", "no change"),
        ([3], "high", "low", "stale"),  # hour 3 is "off" in the config, not "high"
    ],
)
def test_lighting_levels_and_hours_must_be_valid(hours, from_, to, expected):
    assert expected in only_reason(check(light("s1", hours, from_, to)))


def test_valid_lighting_change_is_applied():
    result = check(light("s1", [18, 19], "high", "off"))
    assert result.rejections == []
    assert result.configs["s1"].lighting[18:20] == ["off", "off"]
    assert result.configs["s1"].lighting[17] == "high"


def test_open_close_changes_must_match_current_config_and_carry_no_hours():
    assert "stale" in only_reason(check(hours_change("s1", "close", "17:00", "19:00")))
    assert "no change" in only_reason(check(hours_change("s1", "close", "18:00", "18:00")))
    with_hours = make_suggestion("s1", "close", "18:00", "19:00", visits=0.0, kwh=0.0, hours=[18])
    assert "lighting changes only" in only_reason(check(with_hours))


def test_clubs_are_immutable_and_unknown_stores_rejected():
    assert "clubs" in only_reason(check(light("c1", [20], "high", "low")))
    assert "unknown store" in only_reason(check(hours_change("zz", "close", "18:00", "19:00")))


def test_store_config_already_tried_is_rejected():
    tried = _base()["s1"].model_copy(update={"close": "20:00"})
    cache.run_record("somekey", 7, {"s1": tried})
    assert "already simulated" in only_reason(check(hours_change("s1", "close", "18:00", "20:00")))
    assert check(hours_change("s1", "close", "18:00", "20:00"), check_tried=False).accepted
    assert check(hours_change("s1", "close", "18:00", "19:30")).accepted


def test_fresh_policy_only_counts_runs_from_this_session():
    tried = _base()["s1"].model_copy(update={"close": "20:00"})
    cache.run_record("oldkey", 3, {"s1": tried})
    cache.set_policy(fresh=True)
    assert check(hours_change("s1", "close", "18:00", "20:00")).accepted
    cache.run_record("newkey", 4, {"s1": tried})
    assert only_reason(check(hours_change("s1", "close", "18:00", "20:00")))


def test_tried_check_runs_on_the_config_as_changed_so_far():
    # close 20:00 alone is new, but close 20:00 + lights off 18-20 was simulated before
    combined = _base()["s1"].model_copy(update={"close": "20:00"})
    combined.lighting[18] = combined.lighting[19] = "off"
    cache.run_record("k", 5, {"s1": combined})
    result = check(
        hours_change("s1", "close", "18:00", "20:00"), light("s1", [18, 19], "high", "off")
    )
    assert [s.field for s in result.accepted] == ["close"]
    assert "already simulated" in result.rejections[0].reason
    assert not cache.store_config_tried("s1", result.configs["s1"])


def test_rejections_carry_the_suggestion_and_are_logged(tmp_path):
    bad = hours_change("c1", "close", "03:00", "04:00")
    _, rejections = rules.validate_changes(_base(), [bad], _map())
    assert rejections[0].suggestion is bad
    rules.log_rejections(9, rejections, agent="test")
    lines = (settings.RUNS_DIR / "9" / "llm_log.jsonl").read_text().splitlines()
    record = json.loads(lines[0])
    assert record["type"] == "rule_rejection"
    assert record["suggestion"]["from"] == "03:00"
    assert "clubs" in record["reason"]


def test_apply_suggestion_normalises_times_and_sets_lighting():
    config = _base()["s1"]
    assert rules.apply_suggestion(config, hours_change("s1", "close", "18:00", "3:00")).close == (
        "03:00"
    )
    lit = rules.apply_suggestion(config, light("s1", [0, 1], "off", "low"))
    assert lit.lighting[:3] == ["low", "low", "off"]
    assert config.lighting[0] == "off"

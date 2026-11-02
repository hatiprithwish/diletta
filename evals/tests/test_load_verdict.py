"""The load test's verdict (diletta_evals.load.verdict): every check passes on a run that met the target, and each one
fails on the run that missed it in just that way."""

from collections import Counter
from datetime import UTC, datetime

import pytest

from diletta_evals.load.chat import TurnResult, UserResult
from diletta_evals.load.constants import BUDGET_OP_P95_MAX_MS, OUTBOX_LAG_P95_MAX_MS, TARGET_CONCURRENT_CHATS
from diletta_evals.load.stats import summarize
from diletta_evals.load.verdict import (
    ChatPhase,
    Check,
    ContentionPhase,
    evaluate_chats,
    evaluate_contention,
    format_checks,
    is_passed,
)
from diletta_evals.types import eval_load

STARTED_AT = datetime(2026, 11, 2, 10, 0, 0, tzinfo=UTC)
TURNS = 3
CALL_COST = 4_000


def timings(*, count: int = 100, p95: float = 40) -> dict[str, object]:
    return {"count": count, "p50Ms": 3, "p95Ms": p95, "maxMs": p95 + 10}


def summary(**overrides: object) -> eval_load.EvalLoadSummaryApiResponse:
    calls = TARGET_CONCURRENT_CHATS * TURNS
    body: dict[str, object] = {
        "isSuccess": True,
        "message": "Load summary read",
        "budget": {
            "spentMicros": 1_000_000 + calls * CALL_COST,
            "budgetMicros": 100_000_000,
            "heldMicros": 0,
            "openReservationCount": 0,
        },
        "timings": {
            "admitTurn": timings(count=calls),
            "reserve": timings(count=calls),
            "settle": timings(count=calls),
        },
        "timingsSince": int(STARTED_AT.timestamp() * 1000),
        "modelCalls": {"callCount": calls, "pendingCount": 0, "costMicros": calls * CALL_COST},
        "outbox": {
            "eventCount": TARGET_CONCURRENT_CHATS + 10,
            "publishedCount": TARGET_CONCURRENT_CHATS + 10,
            "unpublishedCount": 0,
            "lagP50Ms": 200,
            "lagP95Ms": 900,
            "lagMaxMs": 1_500,
        },
    }
    body.update(overrides)
    return eval_load.EvalLoadSummaryApiResponse.model_validate(body)


def window() -> eval_load.EvalLoadWindowApiResponse:
    return eval_load.EvalLoadWindowApiResponse.model_validate(
        {
            "isSuccess": True,
            "message": "Load window started",
            "startedAt": STARTED_AT.isoformat(),
            "budget": {"spentMicros": 1_000_000, "budgetMicros": 100_000_000, "heldMicros": 0, "openReservationCount": 0},
        }
    )


def users(count: int = TARGET_CONCURRENT_CHATS) -> list[UserResult]:
    return [
        UserResult(
            index=index,
            is_connected=True,
            turns=[TurnResult(True, 400, 150) for _ in range(TURNS)],
            is_rating_expected=index < 10,
            is_rating_saved=index < 10,
        )
        for index in range(count)
    ]


def chats(**overrides: object) -> ChatPhase:
    fields: dict[str, object] = {
        "users": users(),
        "turns_per_user": TURNS,
        "peak_open": TARGET_CONCURRENT_CHATS,
        "server_errors": 0,
        "window": window(),
        "summary": summary(),
    }
    fields.update(overrides)
    return ChatPhase(**fields)


def failed(checks: list[Check]) -> list[str]:
    return [check.name for check in checks if not check.is_passed]


def test_a_run_that_meets_the_target_passes_every_check() -> None:
    checks = evaluate_chats(chats())
    assert failed(checks) == []
    assert is_passed(checks)
    assert "PASS" in format_checks("Chats", checks)


def test_fewer_users_than_the_target_is_a_smoke_run_that_fails_the_target() -> None:
    few = users(5)
    checks = evaluate_chats(chats(users=few, peak_open=5))
    assert f"{TARGET_CONCURRENT_CHATS} chats open at once" in failed(checks)
    assert not is_passed(checks)


def test_chats_that_were_never_all_open_together_fail() -> None:
    assert failed(evaluate_chats(chats(peak_open=TARGET_CONCURRENT_CHATS - 1)))[0].endswith("chats open at once")


def test_a_turn_without_an_answer_fails() -> None:
    broken = users()
    broken[3].turns[2] = TurnResult(False, 90_000, None, "no answer in time")
    broken[3].failure = "Turn 3: no answer in time"
    checks = evaluate_chats(chats(users=broken))
    assert "Every turn answered" in failed(checks)


def test_a_server_error_fails() -> None:
    assert "No server error" in failed(evaluate_chats(chats(server_errors=1)))


@pytest.mark.parametrize("operation", ["admitTurn", "reserve", "settle"])
def test_a_slow_budget_operation_fails_its_check(operation: str) -> None:
    slow = {
        "admitTurn": timings(count=150),
        "reserve": timings(count=150),
        "settle": timings(count=150),
        operation: timings(count=150, p95=BUDGET_OP_P95_MAX_MS + 1),
    }
    names = failed(evaluate_chats(chats(summary=summary(timings=slow))))
    assert [name for name in names if name.startswith("BudgetDO")] == [
        f"BudgetDO {'admit' if operation == 'admitTurn' else operation} p95 ≤ {BUDGET_OP_P95_MAX_MS} ms"
    ]


def test_no_timings_at_all_is_not_a_pass() -> None:
    empty = {name: timings(count=0, p95=0) for name in ("admitTurn", "reserve", "settle")}
    assert len([name for name in failed(evaluate_chats(chats(summary=summary(timings=empty)))) if name.startswith("BudgetDO")]) >= 3


def test_a_hold_never_settled_fails() -> None:
    unsettled = {"admitTurn": timings(count=150), "reserve": timings(count=150), "settle": timings(count=149)}
    assert "Every turn admitted, every hold settled" in failed(evaluate_chats(chats(summary=summary(timings=unsettled))))


def test_an_evicted_budget_do_fails_because_its_timings_do_not_cover_the_run() -> None:
    late = int(STARTED_AT.timestamp() * 1000) + 60_000
    assert "BudgetDO counted the whole run" in failed(evaluate_chats(chats(summary=summary(timingsSince=late))))


def test_a_clock_skew_within_the_tolerance_is_not_an_eviction() -> None:
    near = int(STARTED_AT.timestamp() * 1000) + 3_000
    assert "BudgetDO counted the whole run" not in failed(evaluate_chats(chats(summary=summary(timingsSince=near))))


@pytest.mark.parametrize(
    ("label", "budget_extra", "calls_extra"),
    [
        ("a lost settle that expired into spend", {"spentMicros": 1_000_000 + 150 * CALL_COST + 120_000}, {}),
        ("a double-counted call", {"spentMicros": 1_000_000 + 150 * CALL_COST + CALL_COST}, {}),
        ("a call the ledger missed", {"spentMicros": 1_000_000 + 149 * CALL_COST}, {}),
        ("a hold still open", {"openReservationCount": 1, "heldMicros": 1000}, {}),
        ("a cost still pending", {}, {"pendingCount": 2}),
    ],
)
def test_spend_that_does_not_agree_fails(label: str, budget_extra: dict[str, int], calls_extra: dict[str, int]) -> None:
    base = summary()
    budget = {**base.budget.model_dump(), **budget_extra}
    calls = {**base.modelCalls.model_dump(), **calls_extra}
    assert "No lost or double-counted spend" in failed(evaluate_chats(chats(summary=summary(budget=budget, modelCalls=calls)))), label


def test_per_call_rounding_up_is_within_the_allowance() -> None:
    base = summary()
    budget = {**base.budget.model_dump(), "spentMicros": base.budget.spentMicros + 100}
    assert "No lost or double-counted spend" not in failed(evaluate_chats(chats(summary=summary(budget=budget))))


def test_outbox_that_lags_or_keeps_events_unpublished_fails() -> None:
    base = summary().outbox.model_dump()
    name = f"Outbox lag p95 ≤ {OUTBOX_LAG_P95_MAX_MS // 1000} s, nothing left unpublished"
    assert name in failed(evaluate_chats(chats(summary=summary(outbox={**base, "lagP95Ms": OUTBOX_LAG_P95_MAX_MS + 1}))))
    assert name in failed(evaluate_chats(chats(summary=summary(outbox={**base, "unpublishedCount": 2, "publishedCount": 58}))))
    # DEV_NOTE: No events at all means the lag wasn't measured, which is not a pass
    assert name in failed(evaluate_chats(chats(summary=summary(outbox={**base, "eventCount": 0, "publishedCount": 0}))))


def test_a_rating_that_was_not_saved_fails() -> None:
    unsaved = users()
    unsaved[0].is_rating_saved = False
    assert "Ratings saved" in failed(evaluate_chats(chats(users=unsaved)))


def contention(**overrides: object) -> ContentionPhase:
    calls = 200
    base = {
        "spentMicros": 5_000_000,
        "budgetMicros": 105_000_000,
        "heldMicros": 0,
        "openReservationCount": 0,
    }
    start = eval_load.EvalLoadWindowApiResponse.model_validate(
        {"isSuccess": True, "message": "ok", "startedAt": STARTED_AT.isoformat(), "budget": base}
    )
    after = summary(budget=base)
    fields: dict[str, object] = {
        "calls": calls,
        "amount_micros": 1_000_000,
        "headroom_micros": 100_000_000,
        "expected_admitted": 100,
        "admitted": 100,
        "refusals": Counter({"CompanyBudget": 100}),
        "errors": 0,
        "reserve_ms": summarize([12.0] * calls),
        "release_ms": summarize([9.0] * 100),
        "window": start,
        "after": after,
    }
    fields.update(overrides)
    return ContentionPhase(**fields)


def test_a_budget_that_admits_exactly_its_room_and_ends_where_it_began_passes() -> None:
    assert failed(evaluate_contention(contention())) == []


@pytest.mark.parametrize("admitted", [99, 101])
def test_admitting_more_or_less_than_the_room_fails(admitted: int) -> None:
    assert "Exactly the room the budget had was admitted" in failed(evaluate_contention(contention(admitted=admitted)))


def test_a_call_that_errored_fails_even_if_the_count_matches() -> None:
    assert "Exactly the room the budget had was admitted" in failed(evaluate_contention(contention(errors=1)))


def test_a_refusal_that_was_not_the_budget_fails() -> None:
    refusals = Counter({"CompanyBudget": 99, "Unavailable": 1})
    assert failed(evaluate_contention(contention(refusals=refusals))) == ["Only the budget refused"]


def test_slow_round_trips_fail() -> None:
    slow = summarize([BUDGET_OP_P95_MAX_MS + 50.0] * 100)
    names = failed(evaluate_contention(contention(reserve_ms=slow, release_ms=slow)))
    assert names == [
        f"Reserve round trip p95 ≤ {BUDGET_OP_P95_MAX_MS} ms under contention",
        f"Release round trip p95 ≤ {BUDGET_OP_P95_MAX_MS} ms under contention",
    ]


def test_a_budget_that_did_not_get_everything_back_fails() -> None:
    base = {"spentMicros": 5_000_000, "budgetMicros": 105_000_000, "heldMicros": 1_000_000, "openReservationCount": 1}
    assert "Everything given back" in failed(evaluate_contention(contention(after=summary(budget=base))))
    spent = {**base, "heldMicros": 0, "openReservationCount": 0, "spentMicros": 5_000_001}
    assert "Everything given back" in failed(evaluate_contention(contention(after=summary(budget=spent))))

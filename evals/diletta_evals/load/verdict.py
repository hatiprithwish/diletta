"""The load test's verdict (M6-5): pure checks over what a run measured, no network. Each check names what it holds the
platform to; the run passes when every check does. The target is packages/schemas' (LOAD_TEST_*), read from the generated
types: 50 concurrent chats of one company, no server error, BudgetDO's admit / reserve / settle at p95 ≤ 250 ms, no lost
or double-counted spend, outbox lag p95 ≤ 60 s, and a budget that under contention admits exactly what it has room for.
"""

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

from diletta_evals.load.chat import UserResult
from diletta_evals.load.constants import BUDGET_OP_P95_MAX_MS, OUTBOX_LAG_P95_MAX_MS, TARGET_CONCURRENT_CHATS
from diletta_evals.load.stats import Durations
from diletta_evals.types import eval_load

# DEV_NOTE: The backend's clock (timingsSince) and the database's (the window's start) are two clocks
CLOCK_SKEW_TOLERANCE_MS = 10_000


@dataclass(frozen=True)
class Check:
    name: str
    is_passed: bool
    detail: str


@dataclass(frozen=True)
class ChatPhase:
    """What the chats measured: the users' own results, the peak of chats open at once and the backend's answers."""

    users: Sequence[UserResult]
    turns_per_user: int
    peak_open: int
    server_errors: int
    window: eval_load.EvalLoadWindowApiResponse
    summary: eval_load.EvalLoadSummaryApiResponse


@dataclass(frozen=True)
class ContentionPhase:
    """What the contention measured: many holds at once against the room the budget had."""

    calls: int
    amount_micros: int
    headroom_micros: int
    expected_admitted: int
    admitted: int
    refusals: Counter[str]
    errors: int
    reserve_ms: Durations
    release_ms: Durations
    window: eval_load.EvalLoadWindowApiResponse
    after: eval_load.EvalLoadSummaryApiResponse


def _within(name: str, timings: eval_load.BudgetOperationTimings) -> Check:
    return Check(
        name=f"BudgetDO {name} p95 ≤ {BUDGET_OP_P95_MAX_MS} ms",
        is_passed=timings.count > 0 and timings.p95Ms <= BUDGET_OP_P95_MAX_MS,
        detail=f"{timings.count} calls, p50 {timings.p50Ms:.0f} ms, p95 {timings.p95Ms:.0f} ms, max {timings.maxMs:.0f} ms",
    )


def evaluate_chats(phase: ChatPhase) -> list[Check]:
    users = list(phase.users)
    expected_turns = len(users) * phase.turns_per_user
    ok_turns = sum(1 for user in users for turn in user.turns if turn.is_ok)
    connected = sum(1 for user in users if user.is_connected)
    failures = Counter(user.failure for user in users if user.failure)
    summary = phase.summary
    timings = summary.timings

    spend_delta = summary.budget.spentMicros - phase.window.budget.spentMicros
    cost = summary.modelCalls.costMicros
    # DEV_NOTE: Each call's cost is rounded up to a whole micro-dollar in the ledger, so the sum may sit above the exact
    # cost by less than one micro per call. A lost settle expires into spend at its whole hold, far above that.
    rounding_allowance = summary.modelCalls.callCount
    started_ms = phase.window.startedAt.timestamp() * 1000

    expected_ratings = sum(1 for user in users if user.is_rating_expected)
    saved_ratings = sum(1 for user in users if user.is_rating_saved)
    outbox = summary.outbox

    return [
        Check(
            f"{TARGET_CONCURRENT_CHATS} chats open at once",
            len(users) >= TARGET_CONCURRENT_CHATS and phase.peak_open >= TARGET_CONCURRENT_CHATS,
            f"{len(users)} users, {connected} connected, peak {phase.peak_open} open together",
        ),
        Check(
            "Every turn answered",
            ok_turns == expected_turns,
            f"{ok_turns}/{expected_turns} turns"
            + (f"; failures: {dict(failures.most_common(3))}" if failures else ""),
        ),
        Check(
            "No server error",
            phase.server_errors == 0,
            f"{phase.server_errors} 5xx or unreachable answers from the backend",
        ),
        _within("admit", timings.admitTurn),
        _within("reserve", timings.reserve),
        _within("settle", timings.settle),
        Check(
            "Every turn admitted, every hold settled",
            timings.admitTurn.count >= ok_turns and timings.reserve.count == timings.settle.count,
            f"{timings.admitTurn.count} admits for {ok_turns} turns; {timings.reserve.count} reserves, {timings.settle.count} settles",
        ),
        Check(
            "BudgetDO counted the whole run",
            summary.timingsSince <= started_ms + CLOCK_SKEW_TOLERANCE_MS,
            "its timings began with the window"
            if summary.timingsSince <= started_ms + CLOCK_SKEW_TOLERANCE_MS
            else f"its timings began {(summary.timingsSince - started_ms) / 1000:.0f} s after the window (the DO was evicted)",
        ),
        Check(
            "No lost or double-counted spend",
            summary.budget.openReservationCount == 0
            and summary.budget.heldMicros == 0
            and summary.modelCalls.pendingCount == 0
            and summary.modelCalls.callCount >= ok_turns
            and 0 <= spend_delta - cost <= rounding_allowance,
            f"ledger +{spend_delta} µ$, {summary.modelCalls.callCount} model calls costing {cost} µ$, "
            f"{summary.budget.openReservationCount} holds open, {summary.modelCalls.pendingCount} calls pending",
        ),
        Check(
            f"Outbox lag p95 ≤ {OUTBOX_LAG_P95_MAX_MS // 1000} s, nothing left unpublished",
            outbox.eventCount >= len(users) and outbox.unpublishedCount == 0 and outbox.lagP95Ms <= OUTBOX_LAG_P95_MAX_MS,
            f"{outbox.eventCount} events, {outbox.unpublishedCount} unpublished, lag p50 {outbox.lagP50Ms:.0f} ms, "
            f"p95 {outbox.lagP95Ms:.0f} ms, max {outbox.lagMaxMs:.0f} ms",
        ),
        Check(
            "Ratings saved",
            saved_ratings == expected_ratings,
            f"{saved_ratings}/{expected_ratings} thumbs-down acknowledged",
        ),
    ]


def evaluate_contention(phase: ContentionPhase) -> list[Check]:
    refused = phase.calls - phase.admitted - phase.errors
    other_refusals = {reason: count for reason, count in phase.refusals.items() if reason != "CompanyBudget"}
    after = phase.after.budget
    before = phase.window.budget

    return [
        Check(
            "Exactly the room the budget had was admitted",
            phase.errors == 0 and phase.admitted == phase.expected_admitted,
            f"{phase.admitted} of {phase.calls} holds of {phase.amount_micros} µ$ admitted, "
            f"{phase.expected_admitted} expected for {phase.headroom_micros} µ$ of room ({refused} refused)",
        ),
        Check(
            "Only the budget refused",
            not other_refusals,
            "every refusal was CompanyBudget" if not other_refusals else f"other refusals: {other_refusals}",
        ),
        Check(
            f"Reserve round trip p95 ≤ {BUDGET_OP_P95_MAX_MS} ms under contention",
            phase.reserve_ms.count > 0 and phase.reserve_ms.p95_ms <= BUDGET_OP_P95_MAX_MS,
            f"{phase.reserve_ms.count} calls, p50 {phase.reserve_ms.p50_ms:.0f} ms, p95 {phase.reserve_ms.p95_ms:.0f} ms, max {phase.reserve_ms.max_ms:.0f} ms",
        ),
        Check(
            f"Release round trip p95 ≤ {BUDGET_OP_P95_MAX_MS} ms under contention",
            phase.release_ms.count > 0 and phase.release_ms.p95_ms <= BUDGET_OP_P95_MAX_MS,
            f"{phase.release_ms.count} calls, p50 {phase.release_ms.p50_ms:.0f} ms, p95 {phase.release_ms.p95_ms:.0f} ms, max {phase.release_ms.max_ms:.0f} ms",
        ),
        Check(
            "Everything given back",
            after.openReservationCount == 0 and after.heldMicros == 0 and after.spentMicros == before.spentMicros,
            f"{after.openReservationCount} holds open, spend {after.spentMicros} µ$ (was {before.spentMicros} µ$)",
        ),
    ]


def is_passed(checks: Sequence[Check]) -> bool:
    return all(check.is_passed for check in checks)


def format_checks(title: str, checks: Sequence[Check]) -> str:
    lines = [title]
    lines.extend(f"  {'PASS' if check.is_passed else 'FAIL'}  {check.name}: {check.detail}" for check in checks)
    return "\n".join(lines)


"""The load test's phases (diletta_evals.load.runner) against an in-memory budget: the contention sizes its holds from the
room the budget reports, releases every hold it got and is judged by what the budget did; the drain waits for the
backend to settle."""

import asyncio
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from diletta_evals.load.api import LoadApiError
from diletta_evals.load.constants import CONTENTION_MAX_AMOUNT_MICROS
from diletta_evals.load.runner import LoadArgs, LoadReport, LoadRunError, _contention_phase, _drain
from diletta_evals.load.verdict import is_passed
from diletta_evals.types import eval_load

STARTED_AT = datetime(2026, 11, 2, 10, 0, 0, tzinfo=UTC)
OPERATION = {"count": 1, "p50Ms": 1, "p95Ms": 2, "maxMs": 3}


def args(**overrides: object) -> LoadArgs:
    fields: dict[str, object] = {
        "users": 50,
        "turns": 4,
        "think_seconds": 7,
        "ramp_seconds": 10,
        "rate_down_percent": 20,
        "contention_calls": 20,
        "drain_seconds": 0,
        "report_path": None,
    }
    fields.update(overrides)
    return LoadArgs(**fields)


class FakeBudgetApi:
    """A company's budget as BudgetDO keeps it: a hold is admitted while it fits the room, and a release gives it back."""

    def __init__(self, *, budget: int = 100_000_000, spent: int = 5_000_000, overadmit: int = 0, leak: bool = False) -> None:
        self.budget = budget
        self.spent = spent
        self.holds: dict[UUID, int] = {}
        self.overadmit = overadmit
        self.leak = leak
        self.reserve_amounts: list[int] = []

    def _snapshot(self) -> dict[str, int]:
        return {
            "spentMicros": self.spent,
            "budgetMicros": self.budget,
            "heldMicros": sum(self.holds.values()),
            "openReservationCount": len(self.holds),
        }

    async def start_window(self) -> eval_load.EvalLoadWindowApiResponse:
        return eval_load.EvalLoadWindowApiResponse.model_validate(
            {"isSuccess": True, "message": "ok", "startedAt": STARTED_AT.isoformat(), "budget": self._snapshot()}
        )

    async def reserve(self, amount_micros: int) -> eval_load.EvalLoadReserveApiResponse:
        self.reserve_amounts.append(amount_micros)
        room = self.budget - self.spent - sum(self.holds.values()) + self.overadmit
        if amount_micros > room:
            body: dict[str, object] = {"isAdmitted": False, "refusal": "CompanyBudget"}
        else:
            reservation_id = uuid4()
            self.holds[reservation_id] = amount_micros
            body = {"isAdmitted": True, "reservationId": str(reservation_id)}
        return eval_load.EvalLoadReserveApiResponse.model_validate(
            {"isSuccess": True, "message": "ok", "serverMs": 4, **body}
        )

    async def release(self, reservation_id: UUID) -> eval_load.EvalLoadReleaseApiResponse:
        if not self.leak:
            self.holds.pop(reservation_id, None)
        return eval_load.EvalLoadReleaseApiResponse.model_validate({"isSuccess": True, "message": "ok", "serverMs": 3})

    async def summary(self, _since: datetime) -> eval_load.EvalLoadSummaryApiResponse:
        return eval_load.EvalLoadSummaryApiResponse.model_validate(
            {
                "isSuccess": True,
                "message": "ok",
                "budget": self._snapshot(),
                "timings": {"admitTurn": OPERATION, "reserve": OPERATION, "settle": OPERATION},
                "timingsSince": 1,
                "modelCalls": {"callCount": 0, "pendingCount": 0, "costMicros": 0},
                "outbox": {
                    "eventCount": 0,
                    "publishedCount": 0,
                    "unpublishedCount": 0,
                    "lagP50Ms": 0,
                    "lagP95Ms": 0,
                    "lagMaxMs": 0,
                },
            }
        )


def run_contention(api: FakeBudgetApi, **overrides: object) -> LoadReport:
    report = LoadReport(started_at="now", users=50, turns_per_user=4)
    asyncio.run(_contention_phase(args(**overrides), api, report))
    return report


def test_the_contention_sizes_the_holds_so_half_fit_and_ends_where_it_began() -> None:
    api = FakeBudgetApi()
    report = run_contention(api)

    # 95,000,000 µ$ of room, 20 holds, half should fit: 10 holds of 9,500,000
    assert set(api.reserve_amounts) == {9_500_000}
    assert len(api.reserve_amounts) == 20
    assert is_passed(report.contention_checks), [c for c in report.contention_checks if not c.is_passed]
    assert api.holds == {}
    assert api.spent == 5_000_000


def test_a_budget_that_admits_more_than_its_room_fails_the_contention() -> None:
    report = run_contention(FakeBudgetApi(overadmit=9_500_000))
    failing = [check.name for check in report.contention_checks if not check.is_passed]
    assert failing == ["Exactly the room the budget had was admitted"]


def test_a_budget_that_keeps_a_hold_after_its_release_fails_the_contention() -> None:
    report = run_contention(FakeBudgetApi(leak=True))
    failing = [check.name for check in report.contention_checks if not check.is_passed]
    assert "Everything given back" in failing


def test_a_budget_with_no_room_to_split_cant_run_the_contention() -> None:
    with pytest.raises(LoadRunError, match="can't be split"):
        run_contention(FakeBudgetApi(budget=100, spent=99))
    with pytest.raises(LoadRunError, match="can't be split"):
        run_contention(FakeBudgetApi(budget=CONTENTION_MAX_AMOUNT_MICROS * 1000, spent=0))


def test_a_reserve_that_errors_counts_against_the_contention() -> None:
    class Flaky(FakeBudgetApi):
        async def reserve(self, amount_micros: int) -> eval_load.EvalLoadReserveApiResponse:
            if len(self.reserve_amounts) == 3:
                self.reserve_amounts.append(amount_micros)
                raise LoadApiError(500, "Server error")
            return await super().reserve(amount_micros)

    report = run_contention(Flaky())
    failing = [check.name for check in report.contention_checks if not check.is_passed]
    assert "Exactly the room the budget had was admitted" in failing


def test_the_drain_waits_until_the_backend_is_quiet_and_gives_up_at_its_deadline() -> None:
    class Settling(FakeBudgetApi):
        def __init__(self) -> None:
            super().__init__()
            self.reads = 0

        async def summary(self, since: datetime) -> eval_load.EvalLoadSummaryApiResponse:
            self.reads += 1
            if self.reads < 3:
                self.holds = {uuid4(): 1}
            else:
                self.holds = {}
            return await super().summary(since)

    async def scenario() -> tuple[int, int]:
        settling = Settling()
        quiet = await _drain(settling, STARTED_AT, 30)
        assert quiet.budget.openReservationCount == 0
        never = FakeBudgetApi()
        never.holds = {uuid4(): 1}
        gave_up = await _drain(never, STARTED_AT, 0)
        return settling.reads, gave_up.budget.openReservationCount

    # DEV_NOTE: The drain's poll interval is real time: keep this fast by patching it
    import diletta_evals.load.runner as runner

    original = runner.DRAIN_POLL_SECONDS
    runner.DRAIN_POLL_SECONDS = 0.01
    try:
        reads, still_open = asyncio.run(scenario())
    finally:
        runner.DRAIN_POLL_SECONDS = original
    assert reads == 3
    assert still_open == 1

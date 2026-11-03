"""The load test (M6-5, docs/runbooks/load.md), two phases on the load test company:

1. Chats. A window starts (BudgetDO's timings start over), N simulated widget users connect through the host's login and
   the widget's socket, all open together, and each sends its turns. The harness waits for the spend and the outbox to
   settle, then reads the window's summary from the backend and checks it (verdict.evaluate_chats).
2. Contention. A new window; many holds hit the company's budget at once, sized so about half fit; each admitted hold is
   released. The budget must admit exactly what it had room for and end where it began (verdict.evaluate_contention).

The model is the stub (apps/test-host, ADR 0005): no provider is called and nothing is billed.
"""

import asyncio
import json
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Protocol
from uuid import UUID

import httpx

from diletta_evals.load.api import LoadApiClient, LoadApiError
from diletta_evals.load.chat import ChatPlan, RunState, UserResult, run_user
from diletta_evals.load.config import LoadSettings
from diletta_evals.load.constants import CONTENTION_MAX_AMOUNT_MICROS
from diletta_evals.load.hosts import new_workspace
from diletta_evals.load.stats import Durations, summarize
from diletta_evals.load.verdict import (
    Check,
    ChatPhase,
    ContentionPhase,
    evaluate_chats,
    evaluate_contention,
    format_checks,
    is_passed,
)
from diletta_evals.types import eval_load

DRAIN_POLL_SECONDS = 3.0


class LoadApi(Protocol):
    """What the phases need of the API (LoadApiClient; tests pass an in-memory budget)."""

    async def start_window(self) -> eval_load.EvalLoadWindowApiResponse: ...

    async def summary(self, since: datetime) -> eval_load.EvalLoadSummaryApiResponse: ...

    async def reserve(self, amount_micros: int) -> eval_load.EvalLoadReserveApiResponse: ...

    async def release(self, reservation_id: UUID) -> eval_load.EvalLoadReleaseApiResponse: ...


class LoadRunError(Exception):
    """The run couldn't be carried out (a setting, the backend, the host), as against a platform that failed its target."""


@dataclass(frozen=True)
class LoadArgs:
    users: int
    turns: int
    think_seconds: float
    ramp_seconds: float
    rate_down_percent: int
    contention_calls: int
    drain_seconds: float
    report_path: str | None


@dataclass
class LoadReport:
    started_at: str
    users: int
    turns_per_user: int
    chat_checks: list[Check] = field(default_factory=list)
    contention_checks: list[Check] = field(default_factory=list)
    turn_total: Durations | None = None
    turn_first_chunk: Durations | None = None

    @property
    def is_passed(self) -> bool:
        return is_passed([*self.chat_checks, *self.contention_checks])


def _log(message: str) -> None:
    sys.stderr.write(f"{message}\n")


async def run_load(settings: LoadSettings, args: LoadArgs) -> LoadReport:
    report = LoadReport(
        started_at=datetime.now(UTC).isoformat(), users=args.users, turns_per_user=args.turns
    )
    limits = httpx.Limits(max_connections=max(args.users, args.contention_calls) + 20)
    async with httpx.AsyncClient(limits=limits) as http:
        api = LoadApiClient(settings, http)
        try:
            await _chat_phase(settings, args, http, api, report)
            await _contention_phase(args, api, report)
        except LoadApiError as error:
            raise LoadRunError(f"The backend refused the load test: {error}") from error
    if args.report_path:
        with open(args.report_path, "w", encoding="utf-8") as file:
            json.dump(asdict(report), file, indent=2, default=str)
    return report


async def _chat_phase(
    settings: LoadSettings, args: LoadArgs, http: httpx.AsyncClient, api: LoadApi, report: LoadReport
) -> None:
    window = await api.start_window()
    _log(f"Window started at {window.startedAt.isoformat()}; budget {window.budget.budgetMicros} µ$, spent {window.budget.spentMicros} µ$")
    plan = ChatPlan(
        users=args.users,
        turns=args.turns,
        think_seconds=args.think_seconds,
        ramp_seconds=args.ramp_seconds,
        rate_down_users=min(args.users, -(-args.users * args.rate_down_percent // 100)),
        workspace=new_workspace(),
    )
    state = RunState(plan)
    _log(f"{args.users} chats × {args.turns} turns, ramp {args.ramp_seconds:.0f} s, think {args.think_seconds:.1f} s")
    users: list[UserResult] = list(
        await asyncio.gather(*(run_user(index, settings=settings, http=http, state=state) for index in range(args.users)))
    )

    summary = await _drain(api, window.startedAt, args.drain_seconds)
    turns = [turn for user in users for turn in user.turns if turn.is_ok]
    turn_total = summarize([turn.total_ms for turn in turns])
    turn_first_chunk = summarize([turn.first_chunk_ms for turn in turns if turn.first_chunk_ms is not None])
    report.turn_total = turn_total
    report.turn_first_chunk = turn_first_chunk
    report.chat_checks = evaluate_chats(
        ChatPhase(
            users=users,
            turns_per_user=args.turns,
            peak_open=state.chats.peak,
            server_errors=state.server_errors,
            window=window,
            summary=summary,
        )
    )
    _log(format_checks("Chats", report.chat_checks))
    _log(
        f"  Turn time (informational): first chunk p50 {turn_first_chunk.p50_ms:.0f} ms, p95 {turn_first_chunk.p95_ms:.0f} ms; "
        f"whole turn p50 {turn_total.p50_ms:.0f} ms, p95 {turn_total.p95_ms:.0f} ms"
    )


async def _drain(api: LoadApi, since: datetime, drain_seconds: float) -> eval_load.EvalLoadSummaryApiResponse:
    """Waits for the settles, the usage and the outbox relay behind the last turn, then returns the summary."""
    deadline = asyncio.get_running_loop().time() + drain_seconds
    while True:
        summary = await api.summary(since)
        is_quiet = (
            summary.budget.openReservationCount == 0
            and summary.modelCalls.pendingCount == 0
            and summary.outbox.unpublishedCount == 0
        )
        if is_quiet or asyncio.get_running_loop().time() >= deadline:
            return summary
        await asyncio.sleep(DRAIN_POLL_SECONDS)


async def _contention_phase(args: LoadArgs, api: LoadApi, report: LoadReport) -> None:
    window = await api.start_window()
    budget = window.budget
    headroom = budget.budgetMicros - budget.spentMicros - budget.heldMicros
    admitted_target = args.contention_calls // 2
    amount = headroom // admitted_target if admitted_target > 0 else 0
    if amount < 1 or amount > CONTENTION_MAX_AMOUNT_MICROS:
        raise LoadRunError(
            f"The budget's room ({headroom} µ$) can't be split into {admitted_target} holds the API accepts: "
            f"raise or lower the load test company's budget (Settings › Budget)"
        )
    expected_admitted = min(args.contention_calls, headroom // amount)
    _log(f"Contention: {args.contention_calls} holds of {amount} µ$ for {headroom} µ$ of room")

    reserved = await asyncio.gather(
        *(api.reserve(amount) for _ in range(args.contention_calls)), return_exceptions=True
    )
    answers = [answer for answer in reserved if isinstance(answer, eval_load.EvalLoadReserveApiResponse)]
    errors = len(reserved) - len(answers)
    admitted = [answer for answer in answers if answer.isAdmitted and answer.reservationId is not None]
    refusals = Counter(answer.refusal.value for answer in answers if not answer.isAdmitted and answer.refusal)

    released = await asyncio.gather(
        *(api.release(answer.reservationId) for answer in admitted if answer.reservationId is not None),
        return_exceptions=True,
    )
    release_answers = [answer for answer in released if isinstance(answer, eval_load.EvalLoadReleaseApiResponse)]
    errors += len(released) - len(release_answers)

    after = await _drain(api, window.startedAt, args.drain_seconds)
    report.contention_checks = evaluate_contention(
        ContentionPhase(
            calls=args.contention_calls,
            amount_micros=amount,
            headroom_micros=headroom,
            expected_admitted=expected_admitted,
            admitted=len(admitted),
            refusals=refusals,
            errors=errors,
            reserve_ms=summarize([answer.serverMs for answer in answers]),
            release_ms=summarize([answer.serverMs for answer in release_answers]),
            window=window,
            after=after,
        )
    )
    _log(format_checks("Contention", report.contention_checks))

# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field


class BudgetSnapshot(BaseModel):
    spentMicros: Annotated[int, Field(ge=0, le=9007199254740991)]
    budgetMicros: Annotated[int, Field(ge=0, le=9007199254740991)]
    heldMicros: Annotated[int, Field(ge=0, le=9007199254740991)]
    openReservationCount: Annotated[int, Field(ge=0, le=9007199254740991)]


class EvalLoadSummaryApiRequest(BaseModel):
    since: AwareDatetime


class BudgetOperationTimings(BaseModel):
    count: Annotated[int, Field(ge=0, le=9007199254740991)]
    p50Ms: Annotated[float, Field(ge=0.0)]
    p95Ms: Annotated[float, Field(ge=0.0)]
    maxMs: Annotated[float, Field(ge=0.0)]


class LoadModelCallStats(BaseModel):
    callCount: Annotated[int, Field(ge=0, le=9007199254740991)]
    pendingCount: Annotated[int, Field(ge=0, le=9007199254740991)]
    costMicros: Annotated[int, Field(ge=0, le=9007199254740991)]


class LoadOutboxStats(BaseModel):
    eventCount: Annotated[int, Field(ge=0, le=9007199254740991)]
    publishedCount: Annotated[int, Field(ge=0, le=9007199254740991)]
    unpublishedCount: Annotated[int, Field(ge=0, le=9007199254740991)]
    lagP50Ms: Annotated[float, Field(ge=0.0)]
    lagP95Ms: Annotated[float, Field(ge=0.0)]
    lagMaxMs: Annotated[float, Field(ge=0.0)]


class EvalLoadReserveApiRequest(BaseModel):
    amountMicros: Annotated[int, Field(ge=1, le=1000000000)]


class Refusal(StrEnum):
    CompanyBudget = "CompanyBudget"
    UserDailyCost = "UserDailyCost"
    UserMessageRate = "UserMessageRate"
    ConversationTurnRate = "ConversationTurnRate"
    ConversationCost = "ConversationCost"
    TurnCost = "TurnCost"
    TurnTokens = "TurnTokens"
    Unavailable = "Unavailable"


class EvalLoadReserveApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    isAdmitted: bool
    reservationId: UUID | None = None
    refusal: Refusal | None = None
    serverMs: Annotated[float, Field(ge=0.0)]


class EvalLoadReleaseApiRequest(BaseModel):
    reservationId: UUID


class EvalLoadReleaseApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    serverMs: Annotated[float, Field(ge=0.0)]


class Failure(StrEnum):
    Unauthorized = "Unauthorized"
    Forbidden = "Forbidden"
    ServerError = "ServerError"
    ChatbotUnavailable = "ChatbotUnavailable"
    BudgetRefused = "BudgetRefused"
    NotFound = "NotFound"
    NotRunning = "NotRunning"
    Invalid = "Invalid"
    Duplicate = "Duplicate"
    Incomplete = "Incomplete"
    NotTesting = "NotTesting"
    NoPublishedConfig = "NoPublishedConfig"
    HostFailed = "HostFailed"
    JudgeUnavailable = "JudgeUnavailable"


class EvalRefusalApiResponse(BaseModel):
    isSuccess: Literal[False]
    message: str
    failure: Failure | None = None


class EvalLoadConstants(BaseModel):
    targetConcurrentChats: Literal[50]
    budgetOpP95MaxMs: Literal[250]
    outboxLagP95MaxMs: Literal[60000]
    stubModelKeyPrefix: Literal["diletta-load-stub-"]
    contentionMaxAmountMicros: Literal[1000000000]
    widgetSubprotocol: Literal["diletta.v1"]
    widgetChatRequestFrameType: Literal["cf_agent_use_chat_request"]
    widgetHostTokenFrameType: Literal["host_token"]
    widgetFeedbackFrameType: Literal["feedback"]
    feedbackRatingDown: Literal[2]


class EvalLoadWindowApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    startedAt: AwareDatetime
    budget: BudgetSnapshot


class BudgetTimings(BaseModel):
    admitTurn: BudgetOperationTimings
    reserve: BudgetOperationTimings
    settle: BudgetOperationTimings


class EvalLoadSummaryApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    budget: BudgetSnapshot
    timings: BudgetTimings
    timingsSince: Annotated[int, Field(ge=0, le=9007199254740991)]
    modelCalls: LoadModelCallStats
    outbox: LoadOutboxStats


class EvalLoad(BaseModel):
    """
    The load test's /eval/load/* API (M6-5): every request and answer, by name, and the load test's constants (each a literal, read by the harness); the root object is never sent
    """

    windowResponse: EvalLoadWindowApiResponse
    summaryRequest: EvalLoadSummaryApiRequest
    summaryResponse: EvalLoadSummaryApiResponse
    reserveRequest: EvalLoadReserveApiRequest
    reserveResponse: EvalLoadReserveApiResponse
    releaseRequest: EvalLoadReleaseApiRequest
    releaseResponse: EvalLoadReleaseApiResponse
    refusal: EvalRefusalApiResponse
    constants: EvalLoadConstants

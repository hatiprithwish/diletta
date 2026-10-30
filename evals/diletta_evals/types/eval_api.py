# Generated from evals/schemas/ by scripts/generate_types.py (pnpm evals:types). Do not edit.

from __future__ import annotations

from enum import Enum, StrEnum
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, RootModel, StringConstraints


class Trigger(Enum):
    number_1 = 1
    number_2 = 2
    number_3 = 3


class CreateEvalRunApiRequest(BaseModel):
    chatbotConfigId: Annotated[str, Field(max_length=64, min_length=1)]
    k: Annotated[int, Field(ge=1, le=10)]
    harnessVersion: Annotated[str, Field(max_length=64, min_length=1)]
    trigger: Trigger


class EvalHarnessRun(BaseModel):
    publicId: Annotated[str, Field(min_length=1)]
    k: Annotated[int, Field(ge=1, le=10)]
    harnessVersion: str


class Role(StrEnum):
    user = "user"
    assistant = "assistant"


class Message(BaseModel):
    role: Role
    text: Annotated[str, Field(max_length=4000, min_length=1)]


class Input(BaseModel):
    schemaVersion: Literal[1]
    messages: Annotated[list[Message], Field(max_length=20, min_length=1)]


class Rubric(RootModel[str]):
    root: Annotated[str, Field(max_length=4000, min_length=1)]


class Kind(StrEnum):
    contains = "contains"
    not_contains = "not_contains"


class Rule(BaseModel):
    kind: Kind
    text: Annotated[str, Field(max_length=500, min_length=1)]


class ForbiddenTool(RootModel[str]):
    root: Annotated[str, Field(pattern="^[A-Za-z][A-Za-z0-9_-]{0,63}$")]


class EvalCaseJsonValue(
    RootModel[
        Optional[
            Union[
                str,
                float,
                bool,
                list[Optional["EvalCaseJsonValue"]],
                dict[str, Optional["EvalCaseJsonValue"]],
            ]
        ]
    ]
):
    root: Optional[
        Union[
            str,
            float,
            bool,
            list[Optional["EvalCaseJsonValue"]],
            dict[str, Optional["EvalCaseJsonValue"]],
        ]
    ]


class Message1(BaseModel):
    role: Role
    text: Annotated[str, Field(max_length=4000, min_length=1)]


class RunEvalAttemptApiRequest(BaseModel):
    caseId: Annotated[str, Field(max_length=64, min_length=1)]
    attempt: Annotated[int, Field(ge=1, le=10)]
    messages: Annotated[list[Message1], Field(max_length=20, min_length=1)]


class TurnStatus(StrEnum):
    completed = "completed"
    error = "error"
    aborted = "aborted"
    skipped = "skipped"


class Status(StrEnum):
    ok = "ok"
    error = "error"
    blocked = "blocked"
    no_change = "no_change"
    committed = "committed"
    verified = "verified"
    undone = "undone"
    failed = "failed"
    needs_review = "needs_review"


class EvalAttemptToolCall(BaseModel):
    toolCallId: str
    toolName: str
    args: dict[str, EvalCaseJsonValue | None] | None
    status: Status | None
    changeRequestId: str | None
    wasApprovalRequired: bool


class Readback(BaseModel):
    toolName: Annotated[str, Field(pattern="^[A-Za-z][A-Za-z0-9_-]{0,63}$")]
    expect: Annotated[
        dict[Annotated[str, StringConstraints(min_length=1)], EvalCaseJsonValue | None],
        Field(max_length=50, min_length=1),
    ]


class EvalReadbackApiRequest(BaseModel):
    conversationId: Annotated[str, Field(max_length=64, min_length=1)]
    changeRequestId: Annotated[str, Field(max_length=64, min_length=1)]
    readback: Readback


class Verdict(StrEnum):
    matches = "matches"
    differs = "differs"
    unknown = "unknown"


class EvalReadbackField(BaseModel):
    name: str
    isMatch: bool
    expected: EvalCaseJsonValue | None
    found: EvalCaseJsonValue | None
    isFound: bool


class EvalJudgeApiRequest(BaseModel):
    conversationId: Annotated[str, Field(max_length=64, min_length=1)]
    rubric: Annotated[str, Field(max_length=4000, min_length=1)]


class Provider(StrEnum):
    google = "google"
    openai = "openai"
    anthropic = "anthropic"


class EvalJudgeApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    hasPassed: bool
    reason: Annotated[str, Field(max_length=600, min_length=1)]
    provider: Provider
    model: str
    promptVersion: Annotated[int, Field(ge=1, le=9007199254740991)]


class Kind1(StrEnum):
    forbidden_tool = "forbidden_tool"
    tool_call = "tool_call"
    readback = "readback"
    judge = "judge"
    rubric = "rubric"


class Detail(RootModel[str]):
    root: Annotated[str, Field(max_length=1000)]


class Check(BaseModel):
    kind: Kind1
    hasPassed: bool
    label: Annotated[str, Field(max_length=200, min_length=1)]
    detail: Detail | None


class Error(RootModel[str]):
    root: Annotated[str, Field(max_length=1000, min_length=1)]


class GraderOutput(BaseModel):
    schemaVersion: Literal[1]
    checks: Annotated[list[Check], Field(max_length=61)]
    error: Error | None


class LatencyMs(RootModel[int]):
    root: Annotated[int, Field(ge=0, le=3600000)]


class RecordEvalResultApiRequest(BaseModel):
    caseId: Annotated[str, Field(max_length=64, min_length=1)]
    attempt: Annotated[int, Field(ge=1, le=10)]
    hasPassed: bool
    graderOutput: GraderOutput
    latencyMs: LatencyMs | None


class RecordEvalResultApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str


class ResetEvalRunApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    isReset: bool


class EvalRunFailure(Enum):
    number_1 = 1
    number_2 = 2
    number_3 = 3
    number_4 = 4


class Status1(Enum):
    number_1 = 1
    number_2 = 2
    number_3 = 3
    number_4 = 4


class StatusLabel(StrEnum):
    Queued = "Queued"
    Running = "Running"
    Done = "Done"
    Failed = "Failed"


class FinishEvalRunApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    status: Status1
    statusLabel: StatusLabel
    caseCount: Annotated[int, Field(ge=0, le=9007199254740991)]
    passAllKCount: Annotated[int, Field(ge=0, le=9007199254740991)]
    hasPassed: bool
    costUsd: str


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
    HostFailed = "HostFailed"
    JudgeUnavailable = "JudgeUnavailable"


class EvalRefusalApiResponse(BaseModel):
    isSuccess: Literal[False]
    message: str
    failure: Failure | None = None


class ToolCall(BaseModel):
    toolName: Annotated[str, Field(pattern="^[A-Za-z][A-Za-z0-9_-]{0,63}$")]
    args: Annotated[
        dict[Annotated[str, StringConstraints(min_length=1)], EvalCaseJsonValue | None],
        Field(max_length=50),
    ]


class Expectations(BaseModel):
    schemaVersion: Literal[2]
    rubric: Rubric | None
    rules: Annotated[list[Rule], Field(max_length=20)]
    toolCalls: Annotated[list[ToolCall], Field(max_length=10)]
    forbiddenTools: Annotated[list[ForbiddenTool], Field(max_length=20)]
    readbacks: Annotated[list[Readback], Field(max_length=10)]


class EvalHarnessCase(BaseModel):
    publicId: Annotated[str, Field(min_length=1)]
    name: str
    isSafety: bool
    input: Input
    expectations: Expectations


class RunEvalAttemptApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    conversationId: str
    turnStatus: TurnStatus
    reply: str
    toolCalls: list[EvalAttemptToolCall]
    latencyMs: Annotated[int, Field(ge=0, le=9007199254740991)]


class EvalReadbackApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    verdict: Verdict
    fields: list[EvalReadbackField]
    reason: str | None


class FinishEvalRunApiRequest(BaseModel):
    isComplete: bool
    failure: EvalRunFailure | None = None


class CreateEvalRunApiResponse(BaseModel):
    isSuccess: Literal[True]
    message: str
    run: EvalHarnessRun
    cases: list[EvalHarnessCase]


class EvalApi(BaseModel):
    """
    The eval harness's /eval/* API (M5-2): every request body and answer, by name; the root object is never sent
    """

    createRunRequest: CreateEvalRunApiRequest
    createRunResponse: CreateEvalRunApiResponse
    runAttemptRequest: RunEvalAttemptApiRequest
    runAttemptResponse: RunEvalAttemptApiResponse
    readbackRequest: EvalReadbackApiRequest
    readbackResponse: EvalReadbackApiResponse
    judgeRequest: EvalJudgeApiRequest
    judgeResponse: EvalJudgeApiResponse
    recordResultRequest: RecordEvalResultApiRequest
    recordResultResponse: RecordEvalResultApiResponse
    resetResponse: ResetEvalRunApiResponse
    finishRequest: FinishEvalRunApiRequest
    finishResponse: FinishEvalRunApiResponse
    refusal: EvalRefusalApiResponse


EvalCaseJsonValue.model_rebuild()

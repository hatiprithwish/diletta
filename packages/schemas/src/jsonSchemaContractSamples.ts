import { ModelProviderEnum } from "./companySecrets";
import { ApprovalRuleApprovalEnum, ModelTierEnum } from "./configSpec";
import {
  EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
  EVAL_CASE_INPUT_SCHEMA_VERSION,
  EVAL_CASE_MAX_VALUES,
  EVAL_CASE_TAG_PLACEHOLDER,
  EvalCaseMessageRoleEnum,
  EvalCaseRuleKindEnum,
} from "./evalCases";
import {
  EVAL_GRADER_OUTPUT_SCHEMA_VERSION,
  EVAL_TRANSCRIPT_SCHEMA_VERSION,
  EvalCheckKindEnum,
  EvalTranscriptEntryKindEnum,
} from "./evalResults";
import {
  EVAL_HOST_TOKEN_HEADER,
  EVAL_JWT_AUDIENCE,
  EVAL_JWT_ISSUER,
  EVAL_JWT_MAX_LIFETIME_SECONDS,
  EvalReadbackVerdictEnum,
  EvalTurnStatusEnum,
} from "./evalHarness";
import {
  LOAD_CONTENTION_MAX_AMOUNT_MICROS,
  LOAD_STUB_MODEL_KEY_PREFIX,
  LOAD_TEST_BUDGET_OP_P95_MAX_MS,
  LOAD_TEST_OUTBOX_LAG_P95_MAX_MS,
  LOAD_TEST_TARGET_CONCURRENT_CHATS,
} from "./evalLoad";
import { BudgetRefusalEnum } from "./budget";
import {
  WIDGET_FEEDBACK_FRAME_TYPE,
  WIDGET_HOST_TOKEN_FRAME_TYPE,
  WidgetChatFrameTypeEnum,
} from "./conversations/ConversationsWidgetFrames";
import { FeedbackRatingIntEnum } from "./feedback";
import { WIDGET_SUBPROTOCOL } from "./widgetAuth/WidgetAuthCommon";
import { TEST_HOST_ADMIN_HEADER, TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS } from "./testHost";
import {
  EvalRunFailureIntEnum,
  EvalRunStatusIntEnum,
  EvalRunStatusLabelEnum,
  EvalRunTriggerIntEnum,
} from "./evalRuns";
import { HostToolStatusEnum, ToolCallStatusIntEnum } from "./toolCalls";

// DEV_NOTE: The contract between packages/schemas and the Python harness (M5-1): for every JSON_SCHEMA_EXPORTS file,
// bodies its Zod schema accepts (valid) and refuses (invalid). `schema:export` writes them to
// evals/fixtures/contract-samples.json; jsonSchemaExports.test.ts holds them to Zod, and evals/tests/test_contract.py
// to the generated Pydantic types, so both sides agree on the same bodies. Invalid bodies break the shape only (a
// missing field, a wrong type or enum, a size, pattern or count): refinements have no JSON Schema form, so the Python
// types can't refuse a body only a refinement does.
export interface JsonSchemaContractSamples {
  valid: unknown[];
  invalid: unknown[];
}

const configSpec = {
  persona: { instructions: "You help facility managers with their registers." },
  procedures: [
    {
      name: "Close inspection",
      whenToUse: "The user asks to close an inspection",
      steps: "Read the record, show the change, wait for approval.",
    },
  ],
  tools: [{ name: "update_record", version: 2 }],
  approvalRules: [
    { roles: ["admin"], tools: ["update_record"], approval: ApprovalRuleApprovalEnum.Auto },
  ],
  routing: {
    small: { provider: ModelProviderEnum.Google, model: "gemini-flash-lite" },
    mid: { provider: ModelProviderEnum.Google, model: "gemini-flash" },
    top: { provider: ModelProviderEnum.Anthropic, model: "claude-sonnet" },
    defaultTier: ModelTierEnum.Mid,
  },
  knowledge: { sourceIds: ["ks_a1"], topK: 8 },
  widget: { greeting: "Hi, what do you need?", suggestions: ["Which inspections are overdue?"] },
};

const caseInput = {
  schemaVersion: EVAL_CASE_INPUT_SCHEMA_VERSION,
  messages: [
    { role: EvalCaseMessageRoleEnum.User, text: "Hi" },
    { role: EvalCaseMessageRoleEnum.Assistant, text: "Hi, what do you need?" },
    {
      role: EvalCaseMessageRoleEnum.User,
      text: `Create a record named Drill ${EVAL_CASE_TAG_PLACEHOLDER} for 120`,
    },
  ],
};

// DEV_NOTE: A rubric-only case (what a v1 body upgrades to) and one with every check
const rubricOnlyExpectations = {
  schemaVersion: EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
  rubric: "Says fire drills are quarterly.",
  rules: [],
  toolCalls: [],
  forbiddenTools: [],
  readbacks: [],
};

const fullExpectations = {
  schemaVersion: EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
  rubric: null,
  rules: [
    { kind: EvalCaseRuleKindEnum.Contains, text: `Drill ${EVAL_CASE_TAG_PLACEHOLDER}` },
    { kind: EvalCaseRuleKindEnum.NotContains, text: "error" },
  ],
  toolCalls: [
    {
      toolName: "create_record",
      args: { name: `Drill ${EVAL_CASE_TAG_PLACEHOLDER}`, amount: 120, tags: ["a"], meta: null },
    },
    { toolName: "list_records", args: {} },
  ],
  forbiddenTools: ["delete_record"],
  readbacks: [
    {
      toolName: "create_record",
      expect: { name: `Drill ${EVAL_CASE_TAG_PLACEHOLDER}`, amount: 120 },
    },
  ],
};

// DEV_NOTE: Every /eval/* message once (M5-2), with ids as the API sends them (public ids)
const graderOutput = {
  schemaVersion: EVAL_GRADER_OUTPUT_SCHEMA_VERSION,
  checks: [
    {
      kind: EvalCheckKindEnum.ToolCall,
      hasPassed: true,
      label: "Called create_record",
      detail: null,
    },
  ],
  error: null,
};
const toolCall = {
  toolCallId: "toolu_1",
  toolName: "create_record",
  args: { name: "Drill t1", amount: 120, tags: ["a"], meta: null },
  status: HostToolStatusEnum.Verified,
  changeRequestId: "cr_1",
  wasApprovalRequired: true,
};
const evalApi = {
  createRunRequest: {
    chatbotConfigId: "cfg_1",
    k: 3,
    harnessVersion: "0.1.0",
    trigger: EvalRunTriggerIntEnum.Manual,
  },
  createRunResponse: {
    isSuccess: true,
    message: "Eval run started",
    run: { publicId: "run_1", k: 3, harnessVersion: "0.1.0" },
    cases: [
      {
        publicId: "case_1",
        name: "Creates a drill",
        isSafety: false,
        input: caseInput,
        expectations: fullExpectations,
      },
    ],
    doneAttempts: [{ caseId: "case_1", attempt: 1 }],
  },
  runAttemptRequest: { caseId: "case_1", attempt: 1, messages: caseInput.messages },
  runAttemptResponse: {
    isSuccess: true,
    message: "Eval attempt ran",
    conversationId: "conv_1",
    turnStatus: EvalTurnStatusEnum.Completed,
    reply: "Created Drill t1.",
    toolCalls: [toolCall, { ...toolCall, toolCallId: "toolu_2", args: null, status: null }],
    latencyMs: 1200,
  },
  readbackRequest: {
    conversationId: "conv_1",
    changeRequestId: "cr_1",
    readback: { toolName: "create_record", expect: { amount: 120 } },
  },
  readbackResponse: {
    isSuccess: true,
    message: "Record read back",
    verdict: EvalReadbackVerdictEnum.Differs,
    fields: [{ name: "amount", isMatch: false, expected: 120, found: null, isFound: false }],
    reason: null,
  },
  judgeRequest: { conversationId: "conv_1", rubric: "Says the refund takes 5 days." },
  judgeResponse: {
    isSuccess: true,
    message: "Attempt judged",
    hasPassed: false,
    reason: "The reply never says how long the refund takes.",
    provider: ModelProviderEnum.Anthropic,
    model: "claude-sonnet-5-5",
    promptVersion: 1,
  },
  recordResultRequest: {
    caseId: "case_1",
    attempt: 1,
    hasPassed: true,
    graderOutput,
    latencyMs: null,
  },
  recordResultResponse: { isSuccess: true, message: "Eval result recorded" },
  resetResponse: { isSuccess: true, message: "Staging data reset", isReset: true },
  finishRequest: { isComplete: false, failure: EvalRunFailureIntEnum.JudgeUnavailable },
  finishResponse: {
    isSuccess: true,
    message: "Eval run finished",
    status: EvalRunStatusIntEnum.Done,
    statusLabel: EvalRunStatusLabelEnum.Done,
    caseCount: 1,
    passAllKCount: 1,
    hasPassed: true,
    failedSafetyCaseCount: 0,
    costUsd: "0.012000",
  },
  refusal: { isSuccess: false, message: "Forbidden", failure: "Forbidden" },
};

const budgetOperationTimings = { count: 120, p50Ms: 3, p95Ms: 41, maxMs: 90 };

const evalLoad = {
  windowResponse: {
    isSuccess: true,
    message: "Load window started",
    startedAt: "2026-11-02T10:00:00.000Z",
    budget: {
      spentMicros: 1_200_000,
      budgetMicros: 10_000_000,
      heldMicros: 0,
      openReservationCount: 0,
    },
  },
  summaryRequest: { since: "2026-11-02T10:00:00.000Z" },
  summaryResponse: {
    isSuccess: true,
    message: "Load summary read",
    budget: {
      spentMicros: 1_500_000,
      budgetMicros: 10_000_000,
      heldMicros: 40_000,
      openReservationCount: 2,
    },
    timings: {
      admitTurn: budgetOperationTimings,
      reserve: budgetOperationTimings,
      settle: budgetOperationTimings,
    },
    timingsSince: 1_793_613_600_000,
    modelCalls: { callCount: 120, pendingCount: 0, costMicros: 300_000 },
    outbox: {
      eventCount: 30,
      publishedCount: 30,
      unpublishedCount: 0,
      lagP50Ms: 220,
      lagP95Ms: 900,
      lagMaxMs: 1_400,
    },
  },
  reserveRequest: { amountMicros: 40_000 },
  reserveResponse: {
    isSuccess: true,
    message: "Budget reserved",
    isAdmitted: true,
    reservationId: "6f1c3a52-0d41-4c0e-9f43-0b2f7d7c1a11",
    serverMs: 12,
  },
  releaseRequest: { reservationId: "6f1c3a52-0d41-4c0e-9f43-0b2f7d7c1a11" },
  releaseResponse: { isSuccess: true, message: "Budget released", serverMs: 7 },
  refusal: { isSuccess: false, message: "Forbidden", failure: "Forbidden" },
  constants: {
    targetConcurrentChats: LOAD_TEST_TARGET_CONCURRENT_CHATS,
    budgetOpP95MaxMs: LOAD_TEST_BUDGET_OP_P95_MAX_MS,
    outboxLagP95MaxMs: LOAD_TEST_OUTBOX_LAG_P95_MAX_MS,
    stubModelKeyPrefix: LOAD_STUB_MODEL_KEY_PREFIX,
    contentionMaxAmountMicros: LOAD_CONTENTION_MAX_AMOUNT_MICROS,
    widgetSubprotocol: WIDGET_SUBPROTOCOL,
    widgetChatRequestFrameType: WidgetChatFrameTypeEnum.ChatRequest,
    widgetHostTokenFrameType: WIDGET_HOST_TOKEN_FRAME_TYPE,
    widgetFeedbackFrameType: WIDGET_FEEDBACK_FRAME_TYPE,
    feedbackRatingDown: FeedbackRatingIntEnum.Down,
  },
};

const evalConstants = {
  evalJwtIssuer: EVAL_JWT_ISSUER,
  evalJwtAudience: EVAL_JWT_AUDIENCE,
  evalJwtMaxLifetimeSeconds: EVAL_JWT_MAX_LIFETIME_SECONDS,
  evalHostTokenHeader: EVAL_HOST_TOKEN_HEADER,
  testHostAdminHeader: TEST_HOST_ADMIN_HEADER,
  testHostTokenMaxLifetimeSeconds: TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS,
  evalRunFailureJudgeUnavailable: EvalRunFailureIntEnum.JudgeUnavailable,
  evalRunFailureHostUnavailable: EvalRunFailureIntEnum.HostUnavailable,
  evalRunFailureServerError: EvalRunFailureIntEnum.ServerError,
  evalRunFailureHarnessError: EvalRunFailureIntEnum.HarnessError,
};

export const JSON_SCHEMA_CONTRACT_SAMPLES: Record<string, JsonSchemaContractSamples> = {
  "config-spec.schema.json": {
    valid: [configSpec],
    invalid: [
      { ...configSpec, persona: undefined },
      { ...configSpec, routing: { ...configSpec.routing, defaultTier: "huge" } },
      { ...configSpec, tools: [{ name: "update_record", version: "2" }] },
    ],
  },
  "eval-grader-output.schema.json": {
    valid: [
      {
        schemaVersion: EVAL_GRADER_OUTPUT_SCHEMA_VERSION,
        checks: [
          {
            kind: EvalCheckKindEnum.ForbiddenTool,
            hasPassed: true,
            label: "Never called delete_record",
            detail: null,
          },
        ],
        error: null,
      },
    ],
    invalid: [
      { schemaVersion: EVAL_GRADER_OUTPUT_SCHEMA_VERSION, checks: [], error: "" },
      {
        schemaVersion: EVAL_GRADER_OUTPUT_SCHEMA_VERSION,
        checks: [{ kind: "vibes", hasPassed: true, label: "x", detail: null }],
        error: null,
      },
    ],
  },
  "eval-transcript.schema.json": {
    valid: [
      {
        schemaVersion: EVAL_TRANSCRIPT_SCHEMA_VERSION,
        entries: [
          {
            kind: EvalTranscriptEntryKindEnum.Message,
            role: EvalCaseMessageRoleEnum.User,
            text: "Hi",
          },
          {
            kind: EvalTranscriptEntryKindEnum.ToolCall,
            toolName: "create_record",
            toolVersion: 1,
            status: ToolCallStatusIntEnum.Ok,
            summary: null,
          },
        ],
      },
    ],
    invalid: [
      {
        schemaVersion: EVAL_TRANSCRIPT_SCHEMA_VERSION,
        entries: [{ kind: EvalTranscriptEntryKindEnum.ToolCall, toolName: "create_record" }],
      },
      { schemaVersion: EVAL_TRANSCRIPT_SCHEMA_VERSION + 1, entries: [] },
    ],
  },
  "eval-case-input.schema.json": {
    valid: [caseInput],
    invalid: [
      { ...caseInput, messages: [] },
      { ...caseInput, messages: [{ role: "system", text: "Hi" }] },
      { ...caseInput, schemaVersion: EVAL_CASE_INPUT_SCHEMA_VERSION + 1 },
    ],
  },
  "eval-case-expectations.schema.json": {
    valid: [rubricOnlyExpectations, fullExpectations],
    invalid: [
      { ...rubricOnlyExpectations, schemaVersion: 1 },
      { ...rubricOnlyExpectations, rules: undefined },
      { ...fullExpectations, rules: [{ kind: "matches", text: "x" }] },
      { ...fullExpectations, forbiddenTools: ["9_not_a_tool_name"] },
      { ...fullExpectations, toolCalls: [{ toolName: "create_record" }] },
      { ...fullExpectations, readbacks: [{ toolName: "create_record", expect: "120" }] },
      // DEV_NOTE: The value counts, exported as minProperties / maxProperties
      { ...fullExpectations, readbacks: [{ toolName: "create_record", expect: {} }] },
      {
        ...fullExpectations,
        toolCalls: [
          {
            toolName: "create_record",
            args: Object.fromEntries(
              Array.from({ length: EVAL_CASE_MAX_VALUES + 1 }, (_, index) => [
                `arg${index}`,
                index,
              ]),
            ),
          },
        ],
      },
    ],
  },
  "eval-api.schema.json": {
    valid: [
      evalApi,
      { ...evalApi, refusal: { isSuccess: false, message: "Unauthorized" } },
      {
        ...evalApi,
        createRunRequest: {
          chatbotId: "bot_1",
          k: 3,
          harnessVersion: "test",
          trigger: EvalRunTriggerIntEnum.Nightly,
        },
      },
    ],
    invalid: [
      { ...evalApi, createRunRequest: { ...evalApi.createRunRequest, k: 0 } },
      { ...evalApi, createRunRequest: { ...evalApi.createRunRequest, trigger: 9 } },
      // DEV_NOTE: M5-5: exactly one target, and a gate names its config
      {
        ...evalApi,
        createRunRequest: {
          k: 3,
          harnessVersion: "test",
          trigger: EvalRunTriggerIntEnum.Nightly,
        },
      },
      {
        ...evalApi,
        createRunRequest: { ...evalApi.createRunRequest, chatbotId: "bot_1" },
      },
      {
        ...evalApi,
        createRunRequest: {
          chatbotId: "bot_1",
          k: 3,
          harnessVersion: "test",
          trigger: EvalRunTriggerIntEnum.Gate,
        },
      },
      { ...evalApi, runAttemptRequest: { ...evalApi.runAttemptRequest, messages: [] } },
      { ...evalApi, runAttemptResponse: { ...evalApi.runAttemptResponse, turnStatus: "done" } },
      {
        ...evalApi,
        readbackRequest: {
          ...evalApi.readbackRequest,
          readback: { toolName: "create_record", expect: {} },
        },
      },
      { ...evalApi, readbackResponse: { ...evalApi.readbackResponse, verdict: "maybe" } },
      { ...evalApi, recordResultRequest: { ...evalApi.recordResultRequest, graderOutput: {} } },
      { ...evalApi, finishResponse: { ...evalApi.finishResponse, costUsd: 0.012 } },
      { ...evalApi, finishRequest: undefined },
      { ...evalApi, finishRequest: { isComplete: false, failure: 9 } },
      { ...evalApi, judgeRequest: { ...evalApi.judgeRequest, rubric: "" } },
      { ...evalApi, judgeResponse: { ...evalApi.judgeResponse, provider: "mistral" } },
      { ...evalApi, refusal: { ...evalApi.refusal, failure: "Teapot" } },
      {
        ...evalApi,
        recordResultRequest: { ...evalApi.recordResultRequest, latencyMs: 2 ** 31 },
      },
    ],
  },
  "eval-load.schema.json": {
    valid: [
      evalLoad,
      {
        ...evalLoad,
        reserveResponse: {
          isSuccess: true,
          message: "Budget refused",
          isAdmitted: false,
          refusal: BudgetRefusalEnum.CompanyBudget,
          serverMs: 4,
        },
      },
    ],
    invalid: [
      { ...evalLoad, windowResponse: { ...evalLoad.windowResponse, startedAt: "yesterday" } },
      { ...evalLoad, summaryRequest: { since: "" } },
      {
        ...evalLoad,
        summaryResponse: {
          ...evalLoad.summaryResponse,
          timings: { admitTurn: budgetOperationTimings },
        },
      },
      {
        ...evalLoad,
        summaryResponse: {
          ...evalLoad.summaryResponse,
          modelCalls: { ...evalLoad.summaryResponse.modelCalls, callCount: -1 },
        },
      },
      { ...evalLoad, reserveRequest: { amountMicros: 0 } },
      { ...evalLoad, reserveRequest: { amountMicros: LOAD_CONTENTION_MAX_AMOUNT_MICROS + 1 } },
      { ...evalLoad, reserveResponse: { ...evalLoad.reserveResponse, refusal: "Teapot" } },
      { ...evalLoad, releaseRequest: { reservationId: "not-a-uuid" } },
      { ...evalLoad, refusal: { ...evalLoad.refusal, failure: "Teapot" } },
      { ...evalLoad, constants: { ...evalLoad.constants, targetConcurrentChats: 51 } },
      {
        ...evalLoad,
        constants: { ...evalLoad.constants, feedbackRatingDown: FeedbackRatingIntEnum.Up },
      },
      { ...evalLoad, constants: { ...evalLoad.constants, widgetSubprotocol: "diletta.v0" } },
    ],
  },
  "eval-case-tag.schema.json": {
    valid: [EVAL_CASE_TAG_PLACEHOLDER],
    invalid: ["{case.id}", 1],
  },
  "eval-constants.schema.json": {
    valid: [evalConstants],
    invalid: [
      { ...evalConstants, evalJwtAudience: "diletta-widget" },
      { ...evalConstants, evalHostTokenHeader: undefined },
      { ...evalConstants, evalRunFailureJudgeUnavailable: EvalRunFailureIntEnum.HarnessError },
    ],
  },
};

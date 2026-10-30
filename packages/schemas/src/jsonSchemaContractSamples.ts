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
import { TEST_HOST_ADMIN_HEADER, TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS } from "./testHost";
import { EvalRunStatusIntEnum, EvalRunStatusLabelEnum, EvalRunTriggerIntEnum } from "./evalRuns";
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
  recordResultRequest: {
    caseId: "case_1",
    attempt: 1,
    hasPassed: true,
    graderOutput,
    latencyMs: null,
  },
  recordResultResponse: { isSuccess: true, message: "Eval result recorded" },
  resetResponse: { isSuccess: true, message: "Staging data reset", isReset: true },
  finishRequest: { isComplete: true },
  finishResponse: {
    isSuccess: true,
    message: "Eval run finished",
    status: EvalRunStatusIntEnum.Done,
    statusLabel: EvalRunStatusLabelEnum.Done,
    caseCount: 1,
    passAllKCount: 1,
    hasPassed: true,
    costUsd: "0.012000",
  },
  refusal: { isSuccess: false, message: "Forbidden", failure: "Forbidden" },
};

const evalConstants = {
  evalJwtIssuer: EVAL_JWT_ISSUER,
  evalJwtAudience: EVAL_JWT_AUDIENCE,
  evalJwtMaxLifetimeSeconds: EVAL_JWT_MAX_LIFETIME_SECONDS,
  evalHostTokenHeader: EVAL_HOST_TOKEN_HEADER,
  testHostAdminHeader: TEST_HOST_ADMIN_HEADER,
  testHostTokenMaxLifetimeSeconds: TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS,
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
    valid: [evalApi, { ...evalApi, refusal: { isSuccess: false, message: "Unauthorized" } }],
    invalid: [
      { ...evalApi, createRunRequest: { ...evalApi.createRunRequest, k: 0 } },
      { ...evalApi, createRunRequest: { ...evalApi.createRunRequest, trigger: 9 } },
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
      { ...evalApi, refusal: { ...evalApi.refusal, failure: "Teapot" } },
      {
        ...evalApi,
        recordResultRequest: { ...evalApi.recordResultRequest, latencyMs: 2 ** 31 },
      },
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
    ],
  },
};

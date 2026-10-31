import { z } from "zod";
import { ZToolDefinitionName } from "../toolDefinitions/ToolDefinitionsCommon";

// DEV_NOTE: eval_cases.input and eval_cases.expectations are jsonb with no schema_version column, so each body carries
// its own schemaVersion. v1 (M4-6) is what a quality issue turns into: a conversation rewritten without personal
// details and a rubric the reply is judged by. M5-1 adds expectations v2 (deterministic rules, tool calls, forbidden
// tools and readback asserts) with an upgrader from v1; a stored v1 body is never rewritten, only upgraded on read
// (loadEvalCaseExpectations). input stays v1. Both are exported to the Python harness (evals/schemas/ → evals/
// diletta_evals/types/), which gets cases already upgraded.
export const EVAL_CASE_INPUT_SCHEMA_VERSION = 1;
export const EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION = 2;

// DEV_NOTE: Sizes of a v1 case: the name, every message, how many messages (the conversation up to the question the
// case asks) and the rubric
export const EVAL_CASE_NAME_MAX_CHARS = 200;
export const EVAL_CASE_MESSAGE_MAX_CHARS = 4000;
export const EVAL_CASE_MAX_MESSAGES = 20;
export const EVAL_CASE_RUBRIC_MAX_CHARS = 4000;

export enum EvalCaseMessageRoleEnum {
  User = "user",
  Assistant = "assistant",
}

export const ZEvalCaseMessage = z.object({
  role: z.enum(EvalCaseMessageRoleEnum),
  text: z.string().trim().min(1).max(EVAL_CASE_MESSAGE_MAX_CHARS),
});
export type EvalCaseMessage = z.infer<typeof ZEvalCaseMessage>;

// DEV_NOTE: A case's conversation, oldest first. It ends with the user's question: the chatbot under test answers it.
export const ZEvalCaseMessages = z
  .array(ZEvalCaseMessage)
  .min(1)
  .max(EVAL_CASE_MAX_MESSAGES)
  .refine((messages) => messages.at(-1)?.role === EvalCaseMessageRoleEnum.User, {
    message: "The last message must be the user's",
  });

export const ZEvalCaseName = z.string().trim().min(1).max(EVAL_CASE_NAME_MAX_CHARS);
export const ZEvalCaseRubric = z.string().trim().min(1).max(EVAL_CASE_RUBRIC_MAX_CHARS);

export const ZEvalCaseInputV1 = z.object({
  schemaVersion: z.literal(EVAL_CASE_INPUT_SCHEMA_VERSION),
  messages: ZEvalCaseMessages,
});
export type EvalCaseInputV1 = z.infer<typeof ZEvalCaseInputV1>;

export const ZEvalCaseExpectationsV1 = z.object({
  schemaVersion: z.literal(1),
  rubric: ZEvalCaseRubric,
});
export type EvalCaseExpectationsV1 = z.infer<typeof ZEvalCaseExpectationsV1>;

// DEV_NOTE: Sizes of a v2 case's checks: rules and their text, expected tool calls, forbidden tools, readbacks, the args
// or fields one call or readback lists, and the whole expectations body as JSON (its values are free JSON)
export const EVAL_CASE_MAX_RULES = 20;
export const EVAL_CASE_RULE_TEXT_MAX_CHARS = 500;
export const EVAL_CASE_MAX_TOOL_CALLS = 10;
export const EVAL_CASE_MAX_FORBIDDEN_TOOLS = 20;
export const EVAL_CASE_MAX_READBACKS = 10;
export const EVAL_CASE_MAX_VALUES = 50;
export const EVAL_CASE_EXPECTATIONS_MAX_CHARS = 20_000;

// DEV_NOTE: State-independent cases (architecture: evals run on the company's staging host, which keeps its records):
// a case names the records it creates with this placeholder, in a message's text, a rule's text and any string value
// of an expected call's args or a readback's expect. The harness replaces every occurrence with one unique token per
// attempt before the run, so attempts never see each other's records and a readback asserts only on its own.
export const EVAL_CASE_TAG_PLACEHOLDER = "{case.tag}";
export const ZEvalCaseTag = z.literal(EVAL_CASE_TAG_PLACEHOLDER);

// DEV_NOTE: A deterministic rule on the chatbot's last reply of the attempt (grader check kind rubric): contains /
// doesn't contain text, case-insensitive, after the tag is filled
export enum EvalCaseRuleKindEnum {
  Contains = "contains",
  NotContains = "not_contains",
}

export const ZEvalCaseRule = z.object({
  kind: z.enum(EvalCaseRuleKindEnum),
  text: z.string().trim().min(1).max(EVAL_CASE_RULE_TEXT_MAX_CHARS),
});
export type EvalCaseRule = z.infer<typeof ZEvalCaseRule>;

// DEV_NOTE: Any JSON value (z.json(), spelled out so the recursion itself carries the id that names it in the exported
// JSON Schema and the generated Python type)
export type EvalCaseJsonValue =
  | string
  | number
  | boolean
  | null
  | EvalCaseJsonValue[]
  | { [key: string]: EvalCaseJsonValue };
export const ZEvalCaseJsonValue: z.ZodType<EvalCaseJsonValue> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(ZEvalCaseJsonValue),
      z.record(z.string(), ZEvalCaseJsonValue),
    ]),
  )
  .meta({ id: "EvalCaseJsonValue" });

// DEV_NOTE: Arg name → the JSON value expected (an arg the tool's input_schema declares; a readback's keys are the
// tool's readback_op.compare keys, which are arg names too). The meta carries the count limits into the exported JSON
// Schema (maxProperties / minProperties), so the Python types hold them too; the refinements hold them here.
const ZEvalCaseValues = z
  .record(z.string().min(1), ZEvalCaseJsonValue)
  .refine((values) => Object.keys(values).length <= EVAL_CASE_MAX_VALUES, {
    message: `At most ${EVAL_CASE_MAX_VALUES} values`,
  })
  .meta({ maxProperties: EVAL_CASE_MAX_VALUES });

// DEV_NOTE: A tool call the chatbot must make in the attempt (grader check kind tool_call). args is a partial match: each
// listed arg must deep-equal the call's (after the tag is filled), unlisted args are ignored, {} = any args. Each
// expected call is matched by a different call the chatbot made, in any order. A write counts once its change request
// was approved (the harness approves every proposal); the tool's version is the one the config under test pins.
export const ZEvalCaseToolCall = z.object({
  toolName: ZToolDefinitionName,
  args: ZEvalCaseValues,
});
export type EvalCaseToolCall = z.infer<typeof ZEvalCaseToolCall>;

// DEV_NOTE: A record read back from the host after the attempt (grader check kind readback), the same path as live
// verification (M3-6): the chatbot's call matched to the toolCalls entry of toolName is read again through that tool's
// readback_op with the call's args and result, and each expect key is compared at its readback_op.compare path. So a
// readback names a write tool listed exactly once in toolCalls.
export const ZEvalCaseReadback = z.object({
  toolName: ZToolDefinitionName,
  expect: ZEvalCaseValues.refine((values) => Object.keys(values).length > 0, {
    message: "Expect at least one value",
  }).meta({ minProperties: 1, maxProperties: EVAL_CASE_MAX_VALUES }),
});
export type EvalCaseReadback = z.infer<typeof ZEvalCaseReadback>;

// DEV_NOTE: Whether a case checks anything besides its rubric: the one test for it (the schema, toEvalCase, the case
// form)
export function hasEvalCaseChecks(checks: {
  rules: unknown[];
  toolCalls: unknown[];
  forbiddenTools: unknown[];
  readbacks: unknown[];
}): boolean {
  return (
    checks.rules.length > 0 ||
    checks.toolCalls.length > 0 ||
    checks.forbiddenTools.length > 0 ||
    checks.readbacks.length > 0
  );
}

// DEV_NOTE: Whether an expectations body is over EVAL_CASE_EXPECTATIONS_MAX_CHARS as JSON (rubric included)
export function isEvalCaseExpectationsTooLong(body: unknown): boolean {
  return JSON.stringify(body).length > EVAL_CASE_EXPECTATIONS_MAX_CHARS;
}

// DEV_NOTE: v2 (M5-1). rubric = what the pinned LLM judge grades the reply on (check kind judge), null = no judge for
// this case; rules, toolCalls, forbiddenTools (tools that must never run in the attempt, check kind forbidden_tool) and
// readbacks are deterministic. A case checks at least one thing. The refinements below (at least one check, the
// forbidden tool and readback rules, the whole-body cap, plus the reserved tool name) have no JSON Schema form, so the
// Python types don't hold them: cases are only written through this schema.
export const ZEvalCaseExpectationsV2 = z
  .object({
    schemaVersion: z.literal(EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION),
    rubric: ZEvalCaseRubric.nullable(),
    rules: z.array(ZEvalCaseRule).max(EVAL_CASE_MAX_RULES),
    toolCalls: z.array(ZEvalCaseToolCall).max(EVAL_CASE_MAX_TOOL_CALLS),
    forbiddenTools: z.array(ZToolDefinitionName).max(EVAL_CASE_MAX_FORBIDDEN_TOOLS),
    readbacks: z.array(ZEvalCaseReadback).max(EVAL_CASE_MAX_READBACKS),
  })
  .superRefine((body, ctx) => {
    if (body.rubric === null && !hasEvalCaseChecks(body))
      ctx.addIssue({ code: "custom", message: "The case checks nothing" });

    if (new Set(body.forbiddenTools).size !== body.forbiddenTools.length) {
      ctx.addIssue({ code: "custom", path: ["forbiddenTools"], message: "A tool is listed twice" });
    }
    const expectedNames = body.toolCalls.map((call) => call.toolName);
    body.forbiddenTools.forEach((name, index) => {
      if (expectedNames.includes(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["forbiddenTools", index],
          message: "A forbidden tool is also an expected call",
        });
      }
    });
    const readbackNames = new Set<string>();
    body.readbacks.forEach((readback, index) => {
      if (readbackNames.has(readback.toolName)) {
        ctx.addIssue({
          code: "custom",
          path: ["readbacks", index, "toolName"],
          message: "A tool is read back twice",
        });
      }
      readbackNames.add(readback.toolName);
      if (expectedNames.filter((name) => name === readback.toolName).length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["readbacks", index, "toolName"],
          message: "A readback names a tool expected exactly once in toolCalls",
        });
      }
    });
    if (isEvalCaseExpectationsTooLong(body)) {
      ctx.addIssue({ code: "custom", message: "The expectations are too long" });
    }
  });
export type EvalCaseExpectationsV2 = z.infer<typeof ZEvalCaseExpectationsV2>;
export type EvalCaseExpectations = EvalCaseExpectationsV2;

// DEV_NOTE: The checks of a case besides its conversation and rubric
export type EvalCaseChecks = Omit<EvalCaseExpectations, "schemaVersion" | "rubric">;

export const EVAL_CASE_NO_CHECKS: EvalCaseChecks = {
  rules: [],
  toolCalls: [],
  forbiddenTools: [],
  readbacks: [],
};

// DEV_NOTE: An upgrader parses a stored body at its own version, then returns the next version's body. Keyed by the
// version it upgrades FROM, one per version below EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION (as ConfigSpecRegistry).
// Bumping: add ZEvalCaseExpectationsV<n+1>, set EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION, register the upgrader from n,
// add an upgrade test, run `pnpm --filter @app/schemas schema:export` and `pnpm evals:types`.
type EvalCaseExpectationsUpgradeResult = { isSuccess: true; body: unknown } | { isSuccess: false };
type EvalCaseExpectationsUpgrader = (body: unknown) => EvalCaseExpectationsUpgradeResult;

// DEV_NOTE: The upgrade receives the stored body parsed by its own version's schema, so no upgrader handles an invalid
// old body: one its version refuses is a failure
function defineEvalCaseExpectationsUpgrader<TFrom extends z.ZodType>(
  fromSchema: TFrom,
  upgrade: (body: z.output<TFrom>) => unknown,
): EvalCaseExpectationsUpgrader {
  return (body) => {
    const parsed = fromSchema.safeParse(body);
    return parsed.success ? { isSuccess: true, body: upgrade(parsed.data) } : { isSuccess: false };
  };
}

const EVAL_CASE_EXPECTATIONS_UPGRADERS: Record<number, EvalCaseExpectationsUpgrader> = {
  1: defineEvalCaseExpectationsUpgrader(
    ZEvalCaseExpectationsV1,
    (body): EvalCaseExpectationsV2 => ({
      schemaVersion: 2,
      rubric: body.rubric,
      ...EVAL_CASE_NO_CHECKS,
    }),
  ),
};

const ZStoredSchemaVersion = z.object({ schemaVersion: z.number().int().min(1) });

// DEV_NOTE: The one way stored expectations are read: upgraded from the body's own version to the current one, then
// held to the current schema. null = an unknown version or a body its own version refuses. Never throws, never writes
// the upgraded body back.
export function loadEvalCaseExpectations(value: unknown): EvalCaseExpectations | null {
  const version = ZStoredSchemaVersion.safeParse(value);
  if (!version.success || version.data.schemaVersion > EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION)
    return null;
  let body: unknown = value;
  for (
    let from = version.data.schemaVersion;
    from < EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION;
    from++
  ) {
    const upgrade = EVAL_CASE_EXPECTATIONS_UPGRADERS[from];
    if (!upgrade) return null;
    const upgraded = upgrade(body);
    if (!upgraded.isSuccess) return null;
    body = upgraded.body;
  }
  const parsed = ZEvalCaseExpectationsV2.safeParse(body);
  return parsed.success ? parsed.data : null;
}

// Whole Eval Case Body — DB shape
// DEV_NOTE: id, companyId and chatbotId are internal bigint ids — used by DAL/Repo only, NEVER sent to a client.
// companyId and chatbotId are both null for a platform case (CHK_eval_cases_platform_chatbot_id); input and
// expectations are jsonb (read untyped): read them through ZEvalCaseInputV1 /
// loadEvalCaseExpectations.
export const ZEvalCase = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string().nullable(),
  chatbotId: z.string().nullable(),
  name: z.string(),
  input: z.unknown(),
  expectations: z.unknown(),
  isSafety: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type EvalCase = z.infer<typeof ZEvalCase>;

// DEV_NOTE: A case as an admin writes it (New case, Edit, and Create test on the Quality page): its name, conversation
// and rubric. The other checks aren't edited on the dashboard (M5-1): an edit keeps them as stored.
export const ZEvalCaseDraft = z.object({
  name: ZEvalCaseName,
  messages: ZEvalCaseMessages,
  rubric: ZEvalCaseRubric,
});
export type EvalCaseDraft = z.infer<typeof ZEvalCaseDraft>;

// DEV_NOTE: A case's conversation, rubric (null = no judge, allowed only while another check is left) and its other
// checks: what its input and expectations hold
export interface EvalCaseBody {
  messages: EvalCaseMessage[];
  rubric: string | null;
  checks: EvalCaseChecks;
}

// DEV_NOTE: The one way a stored case's input and expectations are read for the dashboard (expectations upgraded to the
// current version). null = a shape this page can't show or edit.
export function readEvalCaseBody(input: unknown, expectations: unknown): EvalCaseBody | null {
  const parsedInput = ZEvalCaseInputV1.safeParse(input);
  const loaded = loadEvalCaseExpectations(expectations);
  if (!parsedInput.success || loaded === null) return null;
  const { schemaVersion: _version, rubric, ...checks } = loaded;
  return { messages: parsedInput.data.messages, rubric, checks };
}

// DEV_NOTE: Why toEvalCase stores nothing: NothingToCheck = no rubric and no other check; TooLong = the expectations
// are over EVAL_CASE_EXPECTATIONS_MAX_CHARS as JSON; Invalid = any other rule of the expectations schema
export enum EvalCaseWriteFailureEnum {
  NothingToCheck = "NothingToCheck",
  TooLong = "TooLong",
  Invalid = "Invalid",
}

export type EvalCaseWriteResult =
  | { isSuccess: true; input: EvalCaseInputV1; expectations: EvalCaseExpectations }
  | { isSuccess: false; failure: EvalCaseWriteFailureEnum; message: string };

// DEV_NOTE: The input (v1) and expectations (current version) of a body, as they are stored, or why it can't be
export function toEvalCase(body: EvalCaseBody): EvalCaseWriteResult {
  if (body.rubric === null && !hasEvalCaseChecks(body.checks)) {
    return {
      isSuccess: false,
      failure: EvalCaseWriteFailureEnum.NothingToCheck,
      message: "The case checks nothing",
    };
  }
  const candidate = {
    schemaVersion: EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
    rubric: body.rubric,
    ...body.checks,
  };
  if (isEvalCaseExpectationsTooLong(candidate)) {
    return {
      isSuccess: false,
      failure: EvalCaseWriteFailureEnum.TooLong,
      message: "The case's checks are too long",
    };
  }
  const expectations = ZEvalCaseExpectationsV2.safeParse(candidate);
  if (!expectations.success) {
    return {
      isSuccess: false,
      failure: EvalCaseWriteFailureEnum.Invalid,
      message: z.prettifyError(expectations.error),
    };
  }
  return {
    isSuccess: true,
    input: { schemaVersion: EVAL_CASE_INPUT_SCHEMA_VERSION, messages: body.messages },
    expectations: expectations.data,
  };
}

export enum EvalCaseSortColumn {
  CreatedAt = "createdAt",
  Name = "name",
}

export const ZEvalCaseSortColumn = z.enum(EvalCaseSortColumn);

// DEV_NOTE: The Cases tab's rows per page
export const EVAL_CASES_PAGE_SIZE = 25;

// DEV_NOTE: Why an edit changed nothing (nothing in the request is written): NotEditable = the stored conversation or
// rubric is a shape this page can't rewrite (readEvalCaseBody null; turning the case on or off still works);
// NothingToCheck = the rubric was cleared on a case with no other check left; TooLong = the new rubric takes the case's
// expectations over EVAL_CASE_EXPECTATIONS_MAX_CHARS (its other checks are kept, so a shorter rubric fits).
export enum EvalCaseUpdateFailureEnum {
  NotEditable = "NotEditable",
  NothingToCheck = "NothingToCheck",
  TooLong = "TooLong",
}

export const EVAL_CASE_UPDATE_FAILURE_HTTP_STATUS_MAP: Record<
  EvalCaseUpdateFailureEnum,
  400 | 409
> = {
  [EvalCaseUpdateFailureEnum.NotEditable]: 409,
  [EvalCaseUpdateFailureEnum.NothingToCheck]: 409,
  [EvalCaseUpdateFailureEnum.TooLong]: 400,
};

// DEV_NOTE: The edit refusal for each reason toEvalCase stores nothing; Invalid has none (on an edit the other checks
// come from a stored body the schema accepted, so it would be a server error)
export const EVAL_CASE_UPDATE_FAILURE_BY_WRITE_FAILURE: Partial<
  Record<EvalCaseWriteFailureEnum, EvalCaseUpdateFailureEnum>
> = {
  [EvalCaseWriteFailureEnum.NothingToCheck]: EvalCaseUpdateFailureEnum.NothingToCheck,
  [EvalCaseWriteFailureEnum.TooLong]: EvalCaseUpdateFailureEnum.TooLong,
};

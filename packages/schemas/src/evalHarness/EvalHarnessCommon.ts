import { z } from "zod";
import {
  ZEvalCaseExpectationsV2,
  ZEvalCaseInputV1,
  ZEvalCaseJsonValue,
  type EvalCaseReadback,
} from "../evalCases/EvalCasesCommon";
import {
  HostCallOutcomeEnum,
  type HostCallResponse,
  type HostConnection,
} from "../hostAdapter/HostAdapterCommon";
import { HostToolStatusEnum } from "../toolCalls/ToolCallsCommon";
import { readValueAtPath } from "../toolDefinitions/ToolOpPlaceholders";
import { compareReadback, type ReadbackExpectation } from "../toolDefinitions/ToolReadbackCompare";
import type { ToolReadbackOp } from "../toolDefinitions/ToolOpsRegistry";

// ─── The eval JWT (M5-2) ────────────────────────────────────────────────────

// DEV_NOTE: /eval/* accepts only this token: signed by the platform's eval key (the harness holds the private key, the
// worker the public JWKS in EVAL_JWT_PUBLIC_JWKS), never by a host. It names one company and one of its connections by
// public id; the worker refuses any connection that isn't Staging, so a production host is never driven by an eval.
// sub = the host's test user, the chatbot user every eval conversation runs as. Short-lived: the harness signs a fresh
// one per request.
export const EVAL_JWT_ISSUER = "diletta-eval-harness";
export const EVAL_JWT_AUDIENCE = "diletta-eval";
export const EVAL_JWT_MAX_LIFETIME_SECONDS = 300;
export const EVAL_JWT_CLOCK_SKEW_SECONDS = 30;
export const EVAL_JWT_MAX_LENGTH = 4096;

// DEV_NOTE: The platform signs with ES256 only: "none", HS* and RS* fail the allowlist
export enum EvalJwtAlgorithmEnum {
  ES256 = "ES256",
}

export const ZEvalJwtHeader = z.object({
  alg: z.enum(EvalJwtAlgorithmEnum),
  kid: z.string().min(1),
  typ: z.string().optional(),
  crit: z.never({ message: "No critical header extensions are supported" }).optional(),
});
export type EvalJwtHeader = z.infer<typeof ZEvalJwtHeader>;

export const ZEvalJwtClaims = z.object({
  iss: z.literal(EVAL_JWT_ISSUER),
  // DEV_NOTE: Validated, never transformed: the chatbot user's host_user_id is exactly the signed value
  sub: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0, { message: "sub must not be blank" }),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
  // DEV_NOTE: Public ids: the company, and the staging connection the run drives
  company: z.string().min(1).max(64),
  connection: z.string().min(1).max(64),
});
export type EvalJwtClaims = z.infer<typeof ZEvalJwtClaims>;

// DEV_NOTE: An eval JWT split into its parts (signingInput = the ASCII bytes of "<header>.<payload>")
export interface DecodedEvalJwt {
  header: EvalJwtHeader;
  claims: EvalJwtClaims;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

// DEV_NOTE: Every failure before the signature and claims pass is Unauthorized, so a made-up token can't tell which
// companies or connections exist. Forbidden = a valid token for a connection that isn't an active Staging one of an
// active company.
export enum EvalAuthFailureEnum {
  Unauthorized = "Unauthorized",
  Forbidden = "Forbidden",
  ServerError = "ServerError",
}

export const EVAL_AUTH_FAILURE_HTTP_STATUS_MAP: Record<EvalAuthFailureEnum, 401 | 403 | 500> = {
  [EvalAuthFailureEnum.Unauthorized]: 401,
  [EvalAuthFailureEnum.Forbidden]: 403,
  [EvalAuthFailureEnum.ServerError]: 500,
};

// DEV_NOTE: Server-side only — the verified eval caller (internal ids): the company, its staging connection (what a
// host call needs, and its reset_op read as stored) and the host test user
export interface EvalIdentity {
  companyId: string;
  connectionId: string;
  connection: HostConnection;
  resetOp: unknown;
  hostUserId: string;
}

// DEV_NOTE: The host bearer token travels in this header on every /eval/* call that reaches the host (an attempt, a
// readback, the reset): the harness gets it from the host's own login. It goes to the Conversation DO's memory or
// straight to the adapter, never to storage or a log (pattern rule 3.11).
export const EVAL_HOST_TOKEN_HEADER = "X-Host-Token";
export const EVAL_HOST_TOKEN_MAX_LENGTH = 8192;

// ─── Runs ───────────────────────────────────────────────────────────────────

// DEV_NOTE: pass^k: each case runs k times and passes only when every attempt does
export const EVAL_RUN_MAX_K = 10;
export const EVAL_HARNESS_VERSION_MAX_CHARS = 64;
// DEV_NOTE: The most cases one run takes (the chatbot's active ones and the platform's): more refuses the run (Invalid)
export const EVAL_RUN_MAX_CASES = 500;
// DEV_NOTE: An attempt's latency as the harness records it: up to an hour (a turn is far shorter)
export const EVAL_RESULT_MAX_LATENCY_MS = 3_600_000;

// DEV_NOTE: A case as the harness runs it: input and expectations already upgraded to the current versions (the
// harness never sees an older shape)
export const ZEvalHarnessCase = z
  .object({
    publicId: z.string().min(1),
    name: z.string(),
    isSafety: z.boolean(),
    input: ZEvalCaseInputV1,
    expectations: ZEvalCaseExpectationsV2,
  })
  .meta({ id: "EvalHarnessCase" });
export type EvalHarnessCase = z.infer<typeof ZEvalHarnessCase>;

export const ZEvalHarnessRun = z
  .object({
    publicId: z.string().min(1),
    k: z.number().int().min(1).max(EVAL_RUN_MAX_K),
    harnessVersion: z.string(),
  })
  .meta({ id: "EvalHarnessRun" });
export type EvalHarnessRun = z.infer<typeof ZEvalHarnessRun>;

// ─── Attempts ───────────────────────────────────────────────────────────────

// DEV_NOTE: How the attempt's one turn ended (Think's own status): completed, error (the model or a tool failed the
// turn: the reply may be empty), aborted (the turn timed out), skipped (Think didn't run it)
export enum EvalTurnStatusEnum {
  Completed = "completed",
  Error = "error",
  Aborted = "aborted",
  Skipped = "skipped",
}

export const ZEvalTurnStatus = z.enum(EvalTurnStatusEnum);

// DEV_NOTE: A tool call's args as the model passed them: a JSON object
export const ZEvalToolArgs = z.record(z.string(), ZEvalCaseJsonValue);

// DEV_NOTE: One tool call the chatbot made in the attempt. args = what the model passed (null when they weren't an
// object); status null = the call never finished. changeRequestId = a write's change request (public id), what a
// readback re-reads.
export const ZEvalAttemptToolCall = z
  .object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: ZEvalToolArgs.nullable(),
    status: z.enum(HostToolStatusEnum).nullable(),
    changeRequestId: z.string().nullable(),
    // DEV_NOTE: The approval rules asked a user to approve this write (Required: the rule, the tool, a destructive write
    // or untrusted input). The eval approved it as that user would; a case can assert the policy with it.
    wasApprovalRequired: z.boolean(),
  })
  .meta({ id: "EvalAttemptToolCall" });
export type EvalAttemptToolCall = z.infer<typeof ZEvalAttemptToolCall>;

// DEV_NOTE: Why an attempt's turn couldn't start (nothing ran): the chatbot or company can't answer (paused, its config
// doesn't load, no model key), a budget said no, or a server fault. The harness fails the attempt with it.
export enum EvalAttemptFailureEnum {
  ChatbotUnavailable = "ChatbotUnavailable",
  BudgetRefused = "BudgetRefused",
  ServerError = "ServerError",
}

export const EVAL_ATTEMPT_FAILURE_HTTP_STATUS_MAP: Record<EvalAttemptFailureEnum, 503 | 500> = {
  [EvalAttemptFailureEnum.ChatbotUnavailable]: 503,
  [EvalAttemptFailureEnum.BudgetRefused]: 503,
  [EvalAttemptFailureEnum.ServerError]: 500,
};

// DEV_NOTE: What a run step refuses with: the run, config, case or conversation isn't the token company's or this run's
// (NotFound), the run isn't Running any more (NotRunning), a body that doesn't fit the run (Invalid: an attempt past
// k, a readback of another tool, a config that doesn't load, no case or too many to run), an attempt already started
// or graded (Duplicate), a Done run still missing an attempt or its reset (Incomplete), the host reset failed
// (HostFailed)
export enum EvalRunStepFailureEnum {
  NotFound = "NotFound",
  NotRunning = "NotRunning",
  Invalid = "Invalid",
  Duplicate = "Duplicate",
  Incomplete = "Incomplete",
  HostFailed = "HostFailed",
  ServerError = "ServerError",
}

export const EVAL_RUN_STEP_FAILURE_HTTP_STATUS_MAP: Record<
  EvalRunStepFailureEnum,
  400 | 404 | 409 | 502 | 500
> = {
  [EvalRunStepFailureEnum.NotFound]: 404,
  [EvalRunStepFailureEnum.NotRunning]: 409,
  [EvalRunStepFailureEnum.Invalid]: 400,
  [EvalRunStepFailureEnum.Duplicate]: 409,
  [EvalRunStepFailureEnum.Incomplete]: 409,
  [EvalRunStepFailureEnum.HostFailed]: 502,
  [EvalRunStepFailureEnum.ServerError]: 500,
};

// DEV_NOTE: Every failure an /eval/* refusal can name (auth, attempt, run step), one value each
export const EVAL_REFUSAL_FAILURES = [
  ...new Set<string>([
    ...Object.values(EvalAuthFailureEnum),
    ...Object.values(EvalAttemptFailureEnum),
    ...Object.values(EvalRunStepFailureEnum),
  ]),
] as [string, ...string[]];

// ─── Readbacks ──────────────────────────────────────────────────────────────

// DEV_NOTE: What one expect field read back as. isFound false = absent from the host's answer (found is null then).
export const ZEvalReadbackField = z
  .object({
    name: z.string(),
    isMatch: z.boolean(),
    expected: ZEvalCaseJsonValue,
    found: ZEvalCaseJsonValue,
    isFound: z.boolean(),
  })
  .meta({ id: "EvalReadbackField" });
export type EvalReadbackField = z.infer<typeof ZEvalReadbackField>;

export enum EvalReadbackVerdictEnum {
  Matches = "matches",
  Differs = "differs",
  // DEV_NOTE: The read failed or an expect key isn't one of the tool's compare keys: never a pass
  Unknown = "unknown",
}

export interface EvalReadbackCheck {
  verdict: EvalReadbackVerdictEnum;
  fields: EvalReadbackField[];
  // Why the verdict is Unknown (safe text: no values, no host text)
  reason: string | null;
}

// DEV_NOTE: The readback assert (M5-1), pure: the record the chatbot's write touched, read again through the tool's
// readback_op with that call's args and result (the same request live verification sends), and each expect key compared
// at its compare path, JSON-equal (types too). Every expect key must be a compare key: one that isn't can't be checked,
// so the verdict is Unknown.
export function checkEvalReadback(params: {
  readbackOp: ToolReadbackOp;
  expect: EvalCaseReadback["expect"];
  readback: Pick<HostCallResponse, "outcome" | "httpStatus" | "body">;
}): EvalReadbackCheck {
  const { readbackOp, expect, readback } = params;
  const unknown = (reason: string): EvalReadbackCheck => ({
    verdict: EvalReadbackVerdictEnum.Unknown,
    fields: [],
    reason,
  });

  const names = Object.keys(expect);
  const notCompared = names.filter((name) => !Object.hasOwn(readbackOp.compare, name));
  if (names.length === 0) return unknown("Nothing to compare");
  if (notCompared.length > 0) {
    return unknown(`Not a compare field of the tool: ${notCompared.join(", ")}`);
  }
  if (readback.outcome !== HostCallOutcomeEnum.Succeeded || readback.body === undefined) {
    return unknown(
      readback.httpStatus === undefined
        ? "The record couldn't be read back"
        : `The record couldn't be read back (HTTP ${readback.httpStatus})`,
    );
  }

  const expectations: ReadbackExpectation[] = names.map((name) => ({
    name,
    path: readbackOp.compare[name] as string,
    expected: { isFound: true, value: expect[name] },
  }));
  const compared = compareReadback(expectations, readback.body);
  const fields = expectations.map((expectation, index) => {
    const found = readValueAtPath(readback.body, expectation.path.split("."));
    const parsed = ZEvalCaseJsonValue.safeParse(found.isFound ? found.value : null);
    return {
      name: expectation.name,
      isMatch: compared.fields[index]?.isMatch ?? false,
      expected: expect[expectation.name] ?? null,
      found: found.isFound && parsed.success ? parsed.data : null,
      isFound: found.isFound,
    };
  });
  return {
    verdict: compared.isMatch ? EvalReadbackVerdictEnum.Matches : EvalReadbackVerdictEnum.Differs,
    fields,
    reason: null,
  };
}

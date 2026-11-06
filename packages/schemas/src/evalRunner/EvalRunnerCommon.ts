import { z } from "zod";
import { EVAL_GATE_MIN_K, EvalRunTriggerIntEnum } from "../evalRuns/EvalRunsCommon";

// ─── The hosted eval runner (M7-9, ADR 0007) ────────────────────────────────

// DEV_NOTE: How the runner signs the host test user in, one login per host app: the same kinds as the harness's
// EVAL_HOST_KIND (evals/diletta_evals/config.py HostKind), so the CLI and the runner read one shape
export enum EvalHostLoginKindEnum {
  TestHost = "test_host",
  Eregister = "eregister",
}

export enum EvalHostLoginKindLabelEnum {
  TestHost = "Test host",
  Eregister = "eRegister",
}

export const EVAL_HOST_LOGIN_KIND_LABEL_MAP: Record<
  EvalHostLoginKindEnum,
  EvalHostLoginKindLabelEnum
> = {
  [EvalHostLoginKindEnum.TestHost]: EvalHostLoginKindLabelEnum.TestHost,
  [EvalHostLoginKindEnum.Eregister]: EvalHostLoginKindLabelEnum.Eregister,
};

// DEV_NOTE: Every field of a login is at most this long (an issuer URL, an email, a Firebase uid or API key)
export const EVAL_HOST_LOGIN_FIELD_MAX_CHARS = 500;

const ZLoginField = z.string().trim().min(1).max(EVAL_HOST_LOGIN_FIELD_MAX_CHARS);

// DEV_NOTE: The host test user's login on a Staging connection, stored as one company secret of type EvalHostLogin
// (encrypted under the company key, JSON). hostUser is the user every eval conversation runs as: the eval JWT's sub,
// and the uid the login must answer for (eRegister: the Firebase uid; the test host: the token's sub). Written by
// operators only; the plaintext leaves the backend only over the runner's service binding (getRunLogin).
export const ZTestHostEvalLogin = z.strictObject({
  kind: z.literal(EvalHostLoginKindEnum.TestHost),
  hostUser: ZLoginField,
  issuer: z.url({ protocol: /^https$/ }).max(EVAL_HOST_LOGIN_FIELD_MAX_CHARS),
  adminSecret: ZLoginField,
});

export const ZEregisterEvalLogin = z.strictObject({
  kind: z.literal(EvalHostLoginKindEnum.Eregister),
  hostUser: ZLoginField,
  firebaseApiKey: ZLoginField,
  email: z.email().max(EVAL_HOST_LOGIN_FIELD_MAX_CHARS),
  password: ZLoginField,
});

export const ZEvalHostLogin = z.discriminatedUnion("kind", [
  ZTestHostEvalLogin,
  ZEregisterEvalLogin,
]);
export type EvalHostLogin = z.infer<typeof ZEvalHostLogin>;

// DEV_NOTE: What the dashboard may start (ADR 0007): a Gate run of a Testing version at the gate's k, or a Manual run
// of any version once per case (a quick check that costs a third of a gate). The nightly suite stays on GitHub.
export const DASHBOARD_EVAL_RUN_TRIGGERS = [
  EvalRunTriggerIntEnum.Gate,
  EvalRunTriggerIntEnum.Manual,
] as const;
export type DashboardEvalRunTrigger = (typeof DASHBOARD_EVAL_RUN_TRIGGERS)[number];

export const DASHBOARD_EVAL_RUN_K: Record<DashboardEvalRunTrigger, number> = {
  [EvalRunTriggerIntEnum.Gate]: EVAL_GATE_MIN_K,
  [EvalRunTriggerIntEnum.Manual]: 1,
};

// DEV_NOTE: A run still Queued this long after it was queued never reached the runner's first step (an instance lost or
// never scheduled): the next Run press fails it (RunnerUnavailable) instead of answering AlreadyRunning forever
export const EVAL_RUN_QUEUED_STALE_MINUTES = 15;

// DEV_NOTE: The harness version a queued run holds until the runner starts it (eval_runs.harness_version is not null);
// /eval/runs replaces it with the runner's own
export const QUEUED_EVAL_RUN_HARNESS_VERSION = "queued";

// DEV_NOTE: The Workflow instance's params: public ids only (instance params are persisted, so never a login or a
// token). The instance id is the run's public id, so a run is started once.
export const ZEvalRunWorkflowParams = z.strictObject({
  companyPublicId: z.string().min(1).max(64),
  runPublicId: z.string().min(1).max(64),
});
export type EvalRunWorkflowParams = z.infer<typeof ZEvalRunWorkflowParams>;

// DEV_NOTE: Why the dashboard couldn't start a run
//   NotTesting: a Gate run of a version that isn't Testing
//   AlreadyRunning: the version already has a Queued or Running run
//   NoTestLogin: no active Staging connection of the company has a test sign-in (an operator sets one)
//   RunnerUnavailable: the runner couldn't take the run (it was marked Failed)
export enum EvalRunStartFailureEnum {
  NotTesting = "NotTesting",
  AlreadyRunning = "AlreadyRunning",
  NoTestLogin = "NoTestLogin",
  RunnerUnavailable = "RunnerUnavailable",
}

export const EVAL_RUN_START_FAILURE_HTTP_STATUS_MAP: Record<EvalRunStartFailureEnum, 409 | 503> = {
  [EvalRunStartFailureEnum.NotTesting]: 409,
  [EvalRunStartFailureEnum.AlreadyRunning]: 409,
  [EvalRunStartFailureEnum.NoTestLogin]: 409,
  [EvalRunStartFailureEnum.RunnerUnavailable]: 503,
};

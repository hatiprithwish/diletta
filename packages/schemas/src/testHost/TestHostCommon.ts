import { z } from "zod";
import { HOST_IDEMPOTENCY_KEY_PATTERN } from "../hostAdapter/HostAdapterCommon";
import { ToolOpMethodEnum } from "../toolDefinitions/ToolOpsV1";
import type { Jwk } from "../widgetAuth/WidgetAuthCommon";

// DEV_NOTE: The test host (M3-3, apps/test-host, docs/runbooks/test-host.md): a stand-in customer app for our own test
// company. It is a full host: it signs the companion JWT the widget sends (aud WIDGET_JWT_AUDIENCE) and its own API
// token (aud TEST_HOST_API_AUDIENCE, the "host token" jwt_forward forwards), serves its JWKS at
// {issuer}/.well-known/jwks.json, and offers a REST API over records under /v1/. Data is kept per workspace (one
// Durable Object each, named by the host token's ws claim), so parallel tests and eval runs never see each other's
// records. Faults can be queued per workspace to drive the adapter's retry, idempotency and mismatch paths. Never a
// platform component: no AppLogger, no Sentry, no database.

// The staging deployment's origin = its issuer (wrangler.jsonc env.staging, TEST_HOST_ISSUER)
export const TEST_HOST_STAGING_ISSUER =
  "https://diletta-test-host-staging.hatiprithwish.workers.dev";

// DEV_NOTE: The test host's API lives under this path; a connection's base_url is the issuer + it
export const TEST_HOST_API_PATH = "/v1/";
export const getTestHostBaseUrl = (issuer: string) =>
  `${issuer.replace(/\/+$/, "")}${TEST_HOST_API_PATH}`;

// DEV_NOTE: The host API token's aud: a companion JWT (aud WIDGET_JWT_AUDIENCE) is never accepted as an API token, and
// an API token never passes widget auth
export const TEST_HOST_API_AUDIENCE = "diletta-test-host";

// Both tokens default to 4 minutes, under the platform's 5-minute companion JWT cap
export const TEST_HOST_TOKEN_LIFETIME_SECONDS = 240;
export const TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS = 300;
// Clock skew allowed on the host token's iat
export const TEST_HOST_TOKEN_CLOCK_SKEW_SECONDS = 60;

// DEV_NOTE: Header carrying TEST_HOST_ADMIN_SECRET: token minting and fault control are admin-only, the record API takes
// a host token
export const TEST_HOST_ADMIN_HEADER = "X-Test-Host-Admin";

// A Native write's key is kept this long; a key seen again within it answers the first result without running again
export const TEST_HOST_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const TEST_HOST_LIST_DEFAULT_LIMIT = 50;
export const TEST_HOST_LIST_MAX_LIMIT = 100;
export const TEST_HOST_MAX_RECORDS = 1_000;
export const TEST_HOST_MAX_FAULTS = 20;
export const TEST_HOST_FAULT_MAX_DELAY_MS = 30_000;

// A workspace (the ws claim, the Durable Object's name) and a record id: URL-safe, short
export const TEST_HOST_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ZTestHostWorkspace = z.string().regex(TEST_HOST_NAME_PATTERN, "Invalid workspace");
export const ZTestHostRecordId = z.string().regex(TEST_HOST_NAME_PATTERN, "Invalid record id");

// Route params: /v1/records/:id and /control/workspaces/:workspace/faults
export const ZTestHostRecordParams = z.strictObject({ id: ZTestHostRecordId });
export const ZTestHostWorkspaceParams = z.strictObject({ workspace: ZTestHostWorkspace });

export enum TestHostRecordStatusEnum {
  Active = "active",
  Archived = "archived",
}

// ─── Records ───────────────────────────────────────────────────────────────

// DEV_NOTE: The host stores email lowercased: a write of "A@X.com" reads back "a@x.com", the "stored in another form"
// case (an Emulated check is Inconclusive, a read-after compare mismatches)
export const ZTestHostRecord = z.strictObject({
  id: ZTestHostRecordId,
  name: z.string(),
  email: z.string(),
  amount: z.number(),
  status: z.enum(TestHostRecordStatusEnum),
});
export type TestHostRecord = z.infer<typeof ZTestHostRecord>;

const ZTestHostRecordFields = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320),
  amount: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  status: z.enum(TestHostRecordStatusEnum),
});

// The body of every answer about one record (GET, POST, PATCH, PUT)
export const ZTestHostRecordResponse = z.object({ data: ZTestHostRecord });
export type TestHostRecordResponse = z.infer<typeof ZTestHostRecordResponse>;

export const ZTestHostRecordListResponse = z.object({ data: z.array(ZTestHostRecord) });
export type TestHostRecordListResponse = z.infer<typeof ZTestHostRecordListResponse>;

// POST /v1/records (status defaults to active) and PUT /v1/records/:id (the whole record)
export const ZTestHostCreateRecordRequest = ZTestHostRecordFields.partial({ status: true });
export type TestHostCreateRecordRequest = z.infer<typeof ZTestHostCreateRecordRequest>;

// PATCH /v1/records/:id: the fields to change, at least one
export const ZTestHostUpdateRecordRequest = ZTestHostRecordFields.partial().refine(
  (fields) => Object.keys(fields).length > 0,
  { message: "Nothing to update" },
);
export type TestHostUpdateRecordRequest = z.infer<typeof ZTestHostUpdateRecordRequest>;

export const ZTestHostListRecordsQuery = z.strictObject({
  status: z.enum(TestHostRecordStatusEnum).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TEST_HOST_LIST_MAX_LIMIT)
    .default(TEST_HOST_LIST_DEFAULT_LIMIT),
});
export type TestHostListRecordsQuery = z.infer<typeof ZTestHostListRecordsQuery>;

// DEV_NOTE: What POST /v1/_reset puts back: the eval suite's fixed starting state (state-independent cases + reset_op)
export const TEST_HOST_SEED_RECORDS: TestHostRecord[] = [
  {
    id: "rec_alpha",
    name: "Alpha Facilities",
    email: "ops@alpha.example",
    amount: 120,
    status: TestHostRecordStatusEnum.Active,
  },
  {
    id: "rec_bravo",
    name: "Bravo Labs",
    email: "admin@bravo.example",
    amount: 45.5,
    status: TestHostRecordStatusEnum.Active,
  },
  {
    id: "rec_charlie",
    name: "Charlie Storage",
    email: "hello@charlie.example",
    amount: 0,
    status: TestHostRecordStatusEnum.Archived,
  },
];

// ─── Faults ────────────────────────────────────────────────────────────────

// DEV_NOTE: A scripted misbehaviour for the next request of a workspace that matches method and path (exact pathname,
// e.g. "/v1/records/rec_alpha"; either omitted = any). Each fault is used once, first match in queue order.
//   status, isApplied false: answered with status before anything runs (a refusal, a 429 / 503 to retry).
//   status, isApplied true: the request runs (and its idempotency key is stored), then the answer is replaced by
//     status: the write landed but the caller can't tell (the case that makes a retried commit dangerous).
//   overwrite: the request runs and answers normally, then these fields are written over the record it touched, like
//     a concurrent edit (the read-after mismatch path).
//   delay: the request runs, the answer is held for ms (past the adapter's timeout = no answer, the write landed).
export enum TestHostFaultKindEnum {
  Status = "status",
  Overwrite = "overwrite",
  Delay = "delay",
}

const ZTestHostFaultMatch = z.object({
  method: z.enum(ToolOpMethodEnum).optional(),
  path: z.string().startsWith("/").max(512).optional(),
});

export const ZTestHostFault = z.discriminatedUnion("kind", [
  ZTestHostFaultMatch.extend({
    kind: z.literal(TestHostFaultKindEnum.Status),
    status: z.number().int().min(400).max(599),
    isApplied: z.boolean(),
    retryAfterSeconds: z.number().int().min(0).max(3_600).optional(),
  }).strict(),
  ZTestHostFaultMatch.extend({
    kind: z.literal(TestHostFaultKindEnum.Overwrite),
    fields: ZTestHostRecordFields.partial().refine((fields) => Object.keys(fields).length > 0, {
      message: "Nothing to overwrite",
    }),
  }).strict(),
  ZTestHostFaultMatch.extend({
    kind: z.literal(TestHostFaultKindEnum.Delay),
    ms: z.number().int().min(1).max(TEST_HOST_FAULT_MAX_DELAY_MS),
  }).strict(),
]);
export type TestHostFault = z.infer<typeof ZTestHostFault>;

// PUT /control/workspaces/:workspace/faults replaces the queue ([] clears it)
export const ZTestHostSetFaultsRequest = z.strictObject({
  faults: z.array(ZTestHostFault).max(TEST_HOST_MAX_FAULTS),
});
export type TestHostSetFaultsRequest = z.infer<typeof ZTestHostSetFaultsRequest>;

// ─── Workspace Durable Object RPC ──────────────────────────────────────────

export enum TestHostOperationKindEnum {
  List = "list",
  Get = "get",
  Create = "create",
  Update = "update",
  Put = "put",
  Delete = "delete",
  Reset = "reset",
}

// DEV_NOTE: One API request as the workspace runs it. method + path pick the fault; idempotencyKey (writes only) and
// the operation itself (its fingerprint) drive the stored-result replay.
export const ZTestHostOperation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(TestHostOperationKindEnum.List),
    query: ZTestHostListRecordsQuery,
  }),
  z.strictObject({ kind: z.literal(TestHostOperationKindEnum.Get), id: ZTestHostRecordId }),
  z.strictObject({
    kind: z.literal(TestHostOperationKindEnum.Create),
    record: ZTestHostCreateRecordRequest,
  }),
  z.strictObject({
    kind: z.literal(TestHostOperationKindEnum.Update),
    id: ZTestHostRecordId,
    fields: ZTestHostUpdateRecordRequest,
  }),
  z.strictObject({
    kind: z.literal(TestHostOperationKindEnum.Put),
    id: ZTestHostRecordId,
    record: ZTestHostCreateRecordRequest,
  }),
  z.strictObject({ kind: z.literal(TestHostOperationKindEnum.Delete), id: ZTestHostRecordId }),
  z.strictObject({ kind: z.literal(TestHostOperationKindEnum.Reset) }),
]);
export type TestHostOperation = z.infer<typeof ZTestHostOperation>;

export const ZTestHostWorkspaceRequest = z.strictObject({
  method: z.enum(ToolOpMethodEnum),
  path: z.string().startsWith("/"),
  idempotencyKey: z.string().regex(HOST_IDEMPOTENCY_KEY_PATTERN).nullable(),
  operation: ZTestHostOperation,
});
export type TestHostWorkspaceRequest = z.infer<typeof ZTestHostWorkspaceRequest>;

// DEV_NOTE: The answer the route sends: status + the JSON body as text (null = no body; text, so the RPC result type
// stays flat), Retry-After when a fault sets it, and how long to hold it (a delay fault)
export interface TestHostWorkspaceResponse {
  status: number;
  body: string | null;
  retryAfterSeconds?: number;
  delayMs?: number;
}

// A stored Native write: what it was (fingerprint) and what it answered
export const ZTestHostStoredResult = z.strictObject({
  fingerprint: z.string(),
  status: z.number().int(),
  body: z.string().nullable(),
  storedAt: z.number().int(),
});
export type TestHostStoredResult = z.infer<typeof ZTestHostStoredResult>;

// ─── Tokens ────────────────────────────────────────────────────────────────

// DEV_NOTE: TEST_HOST_SIGNING_KEY (a Worker secret, JSON): the ES256 private key both tokens are signed with, and its
// kid. The JWKS serves the public members only.
export const ZTestHostSigningKey = z.strictObject({
  kid: z.string().min(1).max(128),
  privateJwk: z.looseObject({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(1),
    y: z.string().min(1),
    d: z.string().min(1),
  }),
});
export type TestHostSigningKey = z.infer<typeof ZTestHostSigningKey>;

export interface TestHostJwks {
  keys: Jwk[];
}

// DEV_NOTE: POST /auth/tokens (admin): what a real host's session endpoint would hand its signed-in user. expiresIn
// may be negative to mint an already-expired token (TokenRejected tests); never above the 5-minute cap.
export const ZTestHostTokenRequest = z.strictObject({
  workspace: ZTestHostWorkspace,
  sub: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  roles: z.array(z.string().min(1).max(64)).max(20).optional(),
  expiresInSeconds: z
    .number()
    .int()
    .min(-TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS)
    .max(TEST_HOST_TOKEN_MAX_LIFETIME_SECONDS)
    .refine((seconds) => seconds !== 0, { message: "expiresInSeconds can't be 0" })
    .optional(),
});
export type TestHostTokenRequest = z.infer<typeof ZTestHostTokenRequest>;

export interface TestHostTokenResponse {
  // For the widget: Sec-WebSocket-Protocol / Authorization on /widget/*
  companionJwt: string;
  // For jwt_forward: the bearer the adapter sends to /v1/*
  hostToken: string;
  // Epoch seconds
  expiresAt: number;
}

// The host API token's claims (aud = TEST_HOST_API_AUDIENCE)
export const ZTestHostTokenClaims = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  aud: z.literal(TEST_HOST_API_AUDIENCE),
  ws: ZTestHostWorkspace,
  iat: z.number().int(),
  exp: z.number().int(),
});
export type TestHostTokenClaims = z.infer<typeof ZTestHostTokenClaims>;

// The error body of every refusal: a short reason, never a token or a request body
export interface TestHostErrorBody {
  error: string;
}

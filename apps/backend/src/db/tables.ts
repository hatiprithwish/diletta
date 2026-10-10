import { sql } from "drizzle-orm";
import { pgTable as table } from "drizzle-orm/pg-core";
import * as t from "drizzle-orm/pg-core";
import * as Schemas from "@app/schemas";

// DEV_NOTE: bigint ids use mode "string" (exact int64, JSON-safe). id is internal only — never sent to a client.
// A reference column whose full (non-partial) unique index leads with it needs no separate IDX_ index.
// Append-only and derived tables (activity_log, event_outbox, activity_rollups, eval_results, knowledge_chunks)
// carry no public_id or updated_at; admins and chatbot_users use clerk_user_id / host_user_id as their client id.

// DEV_NOTE: Enum ints inlined into CHECK and partial-index SQL; DDL can't take bound parameters.
const lit = (value: number) => sql.raw(String(value));

const tsvector = t.customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// DEV_NOTE: Tenancy root. companies.id is the tenant key that withTenant puts in app.company_id.
export const companies = table(
  "companies",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    name: t.text().notNull(),
    status: t.smallint().$type<Schemas.CompanyStatusIntEnum>().notNull().default(1), // CompanyStatusIntEnum.Active
    isReadOnly: t.boolean("is_read_only").notNull().default(false),
    spendingBudget: t.numeric("spending_budget", { precision: 12, scale: 6 }),
    contentRetentionDays: t.integer("content_retention_days"),
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_companies_public_id").on(table.publicId),
    t.index("IDX_companies_updated_by").on(table.updatedBy),
  ],
);

// DEV_NOTE: Golden tenant table. company_id on every row; the DAL filters on it inside withTenant.
export const chatbots = table(
  "chatbots",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    name: t.text().notNull(),
    status: t.smallint().$type<Schemas.ChatbotStatusIntEnum>().notNull().default(1), // ChatbotStatusIntEnum.Active
    isDefault: t.boolean("is_default").notNull().default(false),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_chatbots_public_id").on(table.publicId),
    // DEV_NOTE: At most one default chatbot per company — the widget loads it when no bot id is given
    t
      .uniqueIndex("UNQ_chatbots_company_id_default")
      .on(table.companyId)
      .where(sql`${table.isDefault}`),
    t.index("IDX_chatbots_company_id").on(table.companyId),
    t.index("IDX_chatbots_created_by").on(table.createdBy),
    t.index("IDX_chatbots_updated_by").on(table.updatedBy),
  ],
);

// ─── Credentials & keys ─────────────────────────────────────────────────────

// DEV_NOTE: One company key per company, encrypted by the platform master key. Max 2 rows during rotation
// (new active + old retiring). encrypted_key is nulled on destroy: that is the crypto-shred.
export const companyEncryptionKeys = table(
  "company_encryption_keys",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    version: t.integer().notNull(),
    encryptedKey: t.bytea("encrypted_key"),
    masterKeyVersion: t.integer("master_key_version").notNull(),
    status: t
      .smallint()
      .$type<Schemas.CompanyEncryptionKeyStatusIntEnum>()
      .notNull()
      .default(Schemas.CompanyEncryptionKeyStatusIntEnum.Active),
    destroyedAt: t.timestamp("destroyed_at", { withTimezone: true }),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_company_encryption_keys_public_id").on(table.publicId),
    t
      .uniqueIndex("UNQ_company_encryption_keys_company_id_version")
      .on(table.companyId, table.version),
    t
      .uniqueIndex("UNQ_company_encryption_keys_company_id_active")
      .on(table.companyId)
      .where(sql`${table.status} = ${lit(Schemas.CompanyEncryptionKeyStatusIntEnum.Active)}`),
  ],
);

// DEV_NOTE: BYOK model keys and host API credentials, encrypted under the company key. Rotation overwrites the row.
export const companySecrets = table(
  "company_secrets",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    type: t.smallint().$type<Schemas.CompanySecretTypeIntEnum>().notNull(),
    provider: t.text(), // model_key only: google / openai / anthropic
    connectionId: t.bigint("connection_id", { mode: "string" }), // → company_connections.id, non model_key only
    encryptedSecret: t.bytea("encrypted_secret").notNull(),
    iv: t.bytea().notNull(),
    encryptionKeyVersion: t.integer("encryption_key_version").notNull(),
    lastFourChars: t.text("last_four_chars").notNull(),
    status: t
      .smallint()
      .$type<Schemas.CompanySecretStatusIntEnum>()
      .notNull()
      .default(Schemas.CompanySecretStatusIntEnum.Active),
    expiresAt: t.timestamp("expires_at", { withTimezone: true }),
    lastValidatedAt: t.timestamp("last_validated_at", { withTimezone: true }),
    rotatedAt: t.timestamp("rotated_at", { withTimezone: true }),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_company_secrets_public_id").on(table.publicId),
    // DEV_NOTE: One active model key per provider, and one active credential per connection and type
    t
      .uniqueIndex("UNQ_company_secrets_company_id_provider_active")
      .on(table.companyId, table.provider)
      .where(
        sql`${table.type} = ${lit(Schemas.CompanySecretTypeIntEnum.ModelKey)} AND ${table.status} = ${lit(Schemas.CompanySecretStatusIntEnum.Active)}`,
      ),
    t
      .uniqueIndex("UNQ_company_secrets_company_id_connection_id_type_active")
      .on(table.companyId, table.connectionId, table.type)
      .where(
        sql`${table.type} <> ${lit(Schemas.CompanySecretTypeIntEnum.ModelKey)} AND ${table.status} = ${lit(Schemas.CompanySecretStatusIntEnum.Active)}`,
      ),
    t.check(
      "CHK_company_secrets_model_key_provider",
      sql`(${table.type} = ${lit(Schemas.CompanySecretTypeIntEnum.ModelKey)}) = (${table.provider} IS NOT NULL)`,
    ),
    t.check(
      "CHK_company_secrets_connection_id",
      sql`(${table.type} <> ${lit(Schemas.CompanySecretTypeIntEnum.ModelKey)}) = (${table.connectionId} IS NOT NULL)`,
    ),
    t.index("IDX_company_secrets_company_id").on(table.companyId),
    t.index("IDX_company_secrets_connection_id").on(table.connectionId),
    t.index("IDX_company_secrets_created_by").on(table.createdBy),
    t.index("IDX_company_secrets_updated_by").on(table.updatedBy),
  ],
);

// DEV_NOTE: Per-user host credential (future auth strategies). Deleted when the chatbot user is erased.
export const chatbotUserSecrets = table(
  "chatbot_user_secrets",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    chatbotUserId: t.bigint("chatbot_user_id", { mode: "string" }).notNull(), // → chatbot_users.id
    connectionId: t.bigint("connection_id", { mode: "string" }).notNull(), // → company_connections.id
    type: t.text().notNull(), // = the connection's auth_type
    encryptedSecret: t.bytea("encrypted_secret").notNull(),
    iv: t.bytea().notNull(),
    encryptionKeyVersion: t.integer("encryption_key_version").notNull(),
    scopes: t.text().array(),
    expiresAt: t.timestamp("expires_at", { withTimezone: true }),
    status: t
      .smallint()
      .$type<Schemas.ChatbotUserSecretStatusIntEnum>()
      .notNull()
      .default(Schemas.ChatbotUserSecretStatusIntEnum.Active),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_chatbot_user_secrets_public_id").on(table.publicId),
    t
      .uniqueIndex("UNQ_chatbot_user_secrets_chatbot_user_id_connection_id")
      .on(table.chatbotUserId, table.connectionId),
    t.index("IDX_chatbot_user_secrets_company_id").on(table.companyId),
    t.index("IDX_chatbot_user_secrets_connection_id").on(table.connectionId),
  ],
);

// ─── Tenancy & identity ─────────────────────────────────────────────────────

// DEV_NOTE: Dashboard sign-ins (Clerk). company_id NULL = operator, set = company admin; no role column.
// clerk_user_id is the client-facing id, so there is no public_id.
export const admins = table(
  "admins",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    clerkUserId: t.text("clerk_user_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }), // → companies.id, null = operator
    email: t.text(),
    name: t.text(),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_admins_clerk_user_id").on(table.clerkUserId),
    t.index("IDX_admins_company_id").on(table.companyId),
  ],
);

// DEV_NOTE: Host end users, keyed by the host JWT sub (host_user_id is the client-facing id, no public_id).
// Erasure replaces host_user_id with a random token and clears display_name.
export const chatbotUsers = table(
  "chatbot_users",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    hostUserId: t.text("host_user_id").notNull(),
    displayName: t.text("display_name"),
    erasedAt: t.timestamp("erased_at", { withTimezone: true }),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t
      .uniqueIndex("UNQ_chatbot_users_company_id_host_user_id")
      .on(table.companyId, table.hostUserId),
  ],
);

// DEV_NOTE: One host API environment. jwt_issuer is the widget lookup key (token iss → row); JWKS is derived
// from it and aud is a platform constant, so neither is stored.
export const companyConnections = table(
  "company_connections",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    environment: t.smallint().$type<Schemas.CompanyConnectionEnvironmentIntEnum>().notNull(),
    adapterType: t
      .smallint("adapter_type")
      .$type<Schemas.CompanyConnectionAdapterTypeIntEnum>()
      .notNull()
      .default(Schemas.CompanyConnectionAdapterTypeIntEnum.Rest),
    baseUrl: t.text("base_url"), // null only for host_exec
    authType: t.text("auth_type").notNull(), // jwt_forward | api_key_header | oauth2_cc | oauth2_authcode | hmac_signed
    authConfig: t.jsonb("auth_config").notNull(),
    credentialScope: t
      .smallint("credential_scope")
      .$type<Schemas.CompanyConnectionCredentialScopeIntEnum>()
      .notNull(),
    jwtIssuer: t.text("jwt_issuer").notNull(),
    allowedOrigins: t.text("allowed_origins").array().notNull(),
    resetOp: t.jsonb("reset_op"), // staging only: eval cleanup after a run
    status: t
      .smallint()
      .$type<Schemas.CompanyConnectionStatusIntEnum>()
      .notNull()
      .default(Schemas.CompanyConnectionStatusIntEnum.Active),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_company_connections_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_company_connections_jwt_issuer").on(table.jwtIssuer),
    t.check(
      "CHK_company_connections_base_url",
      sql`${table.baseUrl} IS NOT NULL OR ${table.adapterType} = ${lit(Schemas.CompanyConnectionAdapterTypeIntEnum.HostExec)}`,
    ),
    t.index("IDX_company_connections_company_id").on(table.companyId),
    t.index("IDX_company_connections_created_by").on(table.createdBy),
    t.index("IDX_company_connections_updated_by").on(table.updatedBy),
  ],
);

// ─── Configuration ──────────────────────────────────────────────────────────

// DEV_NOTE: Versioned config of one chatbot. body is editable only while draft (Repo layer). Publish is one
// transaction (old published → archived, new → published); the partial unique index blocks a second live config.
export const chatbotConfigs = table(
  "chatbot_configs",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    chatbotId: t.bigint("chatbot_id", { mode: "string" }).notNull(), // → chatbots.id
    configVersion: t.integer("config_version").notNull(),
    schemaVersion: t.smallint("schema_version").notNull().default(1),
    status: t
      .smallint()
      .$type<Schemas.ChatbotConfigStatusIntEnum>()
      .notNull()
      .default(Schemas.ChatbotConfigStatusIntEnum.Draft),
    body: t.jsonb().notNull(),
    bodyHash: t.text("body_hash").notNull(),
    approvedByRunId: t.bigint("approved_by_run_id", { mode: "string" }), // → eval_runs.id (gate run)
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    publishedBy: t.bigint("published_by", { mode: "string" }), // → admins.id, null = system
    publishedAt: t.timestamp("published_at", { withTimezone: true }),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_chatbot_configs_public_id").on(table.publicId),
    t
      .uniqueIndex("UNQ_chatbot_configs_chatbot_id_config_version")
      .on(table.chatbotId, table.configVersion),
    t
      .uniqueIndex("UNQ_chatbot_configs_chatbot_id_published")
      .on(table.chatbotId)
      .where(sql`${table.status} = ${lit(Schemas.ChatbotConfigStatusIntEnum.Published)}`),
    t.uniqueIndex("UNQ_chatbot_configs_approved_by_run_id").on(table.approvedByRunId),
    t.index("IDX_chatbot_configs_company_id").on(table.companyId),
    t.index("IDX_chatbot_configs_created_by").on(table.createdBy),
    t.index("IDX_chatbot_configs_updated_by").on(table.updatedBy),
    t.index("IDX_chatbot_configs_published_by").on(table.publishedBy),
  ],
);

// DEV_NOTE: Curated manifest of host API operations. Versions are immutable; placeholders {args.*} {before.*}
// {result.*}. Read tools have no readback_op; every write has one (read-before + read-after).
export const toolDefinitions = table(
  "tool_definitions",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    connectionId: t.bigint("connection_id", { mode: "string" }).notNull(), // → company_connections.id
    name: t.text().notNull(),
    version: t.integer().notNull(),
    description: t.text().notNull(),
    risk: t.smallint().$type<Schemas.ToolDefinitionRiskIntEnum>().notNull(),
    inputSchema: t.jsonb("input_schema").notNull(),
    callOp: t.jsonb("call_op").notNull(),
    readbackOp: t.jsonb("readback_op"),
    inverseOp: t.jsonb("inverse_op"), // null = not undoable
    idempotencyMode: t
      .smallint("idempotency_mode")
      .$type<Schemas.ToolDefinitionIdempotencyModeIntEnum>()
      .notNull(),
    approval: t.smallint().$type<Schemas.ToolDefinitionApprovalIntEnum>().notNull(),
    source: t.smallint().$type<Schemas.ToolDefinitionSourceIntEnum>().notNull(),
    status: t
      .smallint()
      .$type<Schemas.ToolDefinitionStatusIntEnum>()
      .notNull()
      .default(Schemas.ToolDefinitionStatusIntEnum.Draft),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_tool_definitions_public_id").on(table.publicId),
    t
      .uniqueIndex("UNQ_tool_definitions_company_id_name_version")
      .on(table.companyId, table.name, table.version),
    t.check(
      "CHK_tool_definitions_readback_op",
      sql`(${table.risk} = ${lit(Schemas.ToolDefinitionRiskIntEnum.Read)}) = (${table.readbackOp} IS NULL)`,
    ),
    t.index("IDX_tool_definitions_connection_id").on(table.connectionId),
    t.index("IDX_tool_definitions_created_by").on(table.createdBy),
    t.index("IDX_tool_definitions_updated_by").on(table.updatedBy),
  ],
);

// DEV_NOTE: Customer-stated minutes per task, for hours saved.
export const roiAssumptions = table(
  "roi_assumptions",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    taskType: t.text("task_type").notNull(),
    manualMinutes: t.numeric("manual_minutes").notNull(),
    effectiveFrom: t.date("effective_from").notNull(),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_roi_assumptions_public_id").on(table.publicId),
    t.index("IDX_roi_assumptions_company_id").on(table.companyId),
    t.index("IDX_roi_assumptions_created_by").on(table.createdBy),
  ],
);

// ─── Evals & learning ───────────────────────────────────────────────────────

// DEV_NOTE: One run of a config against its eval cases. Publish gate = trigger gate AND has_passed.
// Pass threshold, judge model and safety rule are pinned by harness_version.
export const evalRuns = table(
  "eval_runs",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    chatbotConfigId: t.bigint("chatbot_config_id", { mode: "string" }).notNull(), // → chatbot_configs.id
    trigger: t.smallint().$type<Schemas.EvalRunTriggerIntEnum>().notNull(),
    harnessVersion: t.text("harness_version").notNull(),
    k: t.smallint().notNull(),
    status: t
      .smallint()
      .$type<Schemas.EvalRunStatusIntEnum>()
      .notNull()
      .default(Schemas.EvalRunStatusIntEnum.Queued),
    caseCount: t.integer("case_count"),
    passAllKCount: t.integer("pass_all_k_count"),
    hasPassed: t.boolean("has_passed"), // null until done
    costUsd: t.numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    finishedAt: t.timestamp("finished_at", { withTimezone: true }),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_eval_runs_public_id").on(table.publicId),
    t.index("IDX_eval_runs_company_id").on(table.companyId),
    t.index("IDX_eval_runs_chatbot_config_id").on(table.chatbotConfigId),
  ],
);

// DEV_NOTE: company_id NULL = platform case (own RLS policy, M1-3); customer cases always name a chatbot.
// Platform safety cases can't be deactivated.
export const evalCases = table(
  "eval_cases",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }), // → companies.id, null = platform
    chatbotId: t.bigint("chatbot_id", { mode: "string" }), // → chatbots.id, null = platform
    name: t.text().notNull(),
    input: t.jsonb().notNull(),
    expectations: t.jsonb().notNull(),
    isSafety: t.boolean("is_safety").notNull().default(false),
    isActive: t.boolean("is_active").notNull().default(true),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_eval_cases_public_id").on(table.publicId),
    t.check(
      "CHK_eval_cases_platform_chatbot_id",
      sql`(${table.companyId} IS NULL) = (${table.chatbotId} IS NULL)`,
    ),
    t.check(
      "CHK_eval_cases_platform_safety_active",
      sql`${table.companyId} IS NOT NULL OR NOT ${table.isSafety} OR ${table.isActive}`,
    ),
    t.index("IDX_eval_cases_company_id").on(table.companyId),
    t.index("IDX_eval_cases_chatbot_id").on(table.chatbotId),
  ],
);

// DEV_NOTE: One row per case per attempt (pass^k). Append-only.
export const evalResults = table(
  "eval_results",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    evalRunId: t.bigint("eval_run_id", { mode: "string" }).notNull(), // → eval_runs.id
    evalCaseId: t.bigint("eval_case_id", { mode: "string" }).notNull(), // → eval_cases.id
    attempt: t.smallint().notNull(), // 1..k
    hasPassed: t.boolean("has_passed").notNull(),
    graderOutput: t.jsonb("grader_output"),
    transcriptFileId: t.bigint("transcript_file_id", { mode: "string" }), // → files.id
    latencyMs: t.integer("latency_ms"),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t
      .uniqueIndex("UNQ_eval_results_eval_run_id_eval_case_id_attempt")
      .on(table.evalRunId, table.evalCaseId, table.attempt),
    t.uniqueIndex("UNQ_eval_results_transcript_file_id").on(table.transcriptFileId),
    t.index("IDX_eval_results_company_id").on(table.companyId),
    t.index("IDX_eval_results_eval_case_id").on(table.evalCaseId),
  ],
);

// DEV_NOTE: Triage inbox. source ties to feedback_id (user) or created_by (admin); converted ties to eval_case_id.
export const qualityIssues = table(
  "quality_issues",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    conversationId: t.bigint("conversation_id", { mode: "string" }).notNull(), // → conversations.id
    changeRequestId: t.bigint("change_request_id", { mode: "string" }), // → change_requests.id
    feedbackId: t.bigint("feedback_id", { mode: "string" }), // → feedback.id, source = user only
    source: t.smallint().$type<Schemas.QualityIssueSourceIntEnum>().notNull(),
    status: t
      .smallint()
      .$type<Schemas.QualityIssueStatusIntEnum>()
      .notNull()
      .default(Schemas.QualityIssueStatusIntEnum.Open),
    issueType: t.smallint("issue_type").$type<Schemas.QualityIssueTypeIntEnum>(), // null until triage
    note: t.text(),
    evalCaseId: t.bigint("eval_case_id", { mode: "string" }), // → eval_cases.id (became a test)
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, source = admin only
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id (triage)
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_quality_issues_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_quality_issues_feedback_id").on(table.feedbackId),
    t.uniqueIndex("UNQ_quality_issues_eval_case_id").on(table.evalCaseId),
    t.check(
      "CHK_quality_issues_user_feedback_id",
      sql`(${table.source} = ${lit(Schemas.QualityIssueSourceIntEnum.User)}) = (${table.feedbackId} IS NOT NULL)`,
    ),
    t.check(
      "CHK_quality_issues_admin_created_by",
      sql`(${table.source} = ${lit(Schemas.QualityIssueSourceIntEnum.Admin)}) = (${table.createdBy} IS NOT NULL)`,
    ),
    t.check(
      "CHK_quality_issues_converted_eval_case_id",
      sql`(${table.status} = ${lit(Schemas.QualityIssueStatusIntEnum.Converted)}) = (${table.evalCaseId} IS NOT NULL)`,
    ),
    t.index("IDX_quality_issues_company_id").on(table.companyId),
    t.index("IDX_quality_issues_conversation_id").on(table.conversationId),
    t.index("IDX_quality_issues_change_request_id").on(table.changeRequestId),
    t.index("IDX_quality_issues_created_by").on(table.createdBy),
    t.index("IDX_quality_issues_updated_by").on(table.updatedBy),
  ],
);

// ─── Conversations & usage ──────────────────────────────────────────────────

// DEV_NOTE: Index of one chat. The live transcript lives in the Think session; public_id = the DO name.
// Content expiry = last_activity_at + companies.content_retention_days.
export const conversations = table(
  "conversations",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    chatbotUserId: t.bigint("chatbot_user_id", { mode: "string" }).notNull(), // → chatbot_users.id
    chatbotId: t.bigint("chatbot_id", { mode: "string" }).notNull(), // → chatbots.id
    chatbotConfigId: t.bigint("chatbot_config_id", { mode: "string" }), // → chatbot_configs.id (current)
    status: t
      .smallint()
      .$type<Schemas.ConversationStatusIntEnum>()
      .notNull()
      .default(Schemas.ConversationStatusIntEnum.Open),
    outcome: t.smallint().$type<Schemas.ConversationOutcomeIntEnum>(),
    title: t.text(),
    lastActivityAt: t.timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    rootLogId: t.bigint("root_log_id", { mode: "string" }), // → activity_log.id (tree root)
    contentPurgedAt: t.timestamp("content_purged_at", { withTimezone: true }),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_conversations_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_conversations_root_log_id").on(table.rootLogId),
    t.index("IDX_conversations_company_id").on(table.companyId),
    t.index("IDX_conversations_chatbot_user_id").on(table.chatbotUserId),
    t.index("IDX_conversations_chatbot_id").on(table.chatbotId),
    t.index("IDX_conversations_chatbot_config_id").on(table.chatbotConfigId),
  ],
);

// DEV_NOTE: Read model of the Think transcript, written on onChatResponse and never read into a turn.
// content is nulled when the chat is purged.
export const messages = table(
  "messages",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    conversationId: t.bigint("conversation_id", { mode: "string" }).notNull(), // → conversations.id
    sessionMessageId: t.text("session_message_id").notNull(), // Think message id
    turnId: t.text("turn_id").notNull(), // ULID; user message + reply share it
    role: t.smallint().$type<Schemas.MessageRoleIntEnum>().notNull(),
    content: t.jsonb(),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_messages_public_id").on(table.publicId),
    // DEV_NOTE: One read-model row per Think message, so a retried turn write skips what it already stored
    t
      .uniqueIndex("UNQ_messages_conversation_id_session_message_id")
      .on(table.conversationId, table.sessionMessageId),
    t.index("IDX_messages_company_id").on(table.companyId),
    t.index("IDX_messages_conversation_id").on(table.conversationId),
  ],
);

// DEV_NOTE: Every tool call in a turn. Risk comes from tool_id + tool_version → tool_definitions.
// encrypted_args (+ iv, key version) are nulled when the chat is purged.
export const toolCalls = table(
  "tool_calls",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    conversationId: t.bigint("conversation_id", { mode: "string" }).notNull(), // → conversations.id
    messageId: t.bigint("message_id", { mode: "string" }), // → messages.id
    turnId: t.text("turn_id").notNull(), // ULID
    toolId: t.bigint("tool_id", { mode: "string" }).notNull(), // → tool_definitions.id
    toolVersion: t.integer("tool_version").notNull(),
    encryptedArgs: t.bytea("encrypted_args"),
    iv: t.bytea(),
    encryptionKeyVersion: t.integer("encryption_key_version"),
    hasUntrustedContext: t.boolean("has_untrusted_context").notNull().default(false),
    status: t.smallint().$type<Schemas.ToolCallStatusIntEnum>().notNull(),
    errorCode: t.text("error_code"),
    latencyMs: t.integer("latency_ms"),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_tool_calls_public_id").on(table.publicId),
    t.index("IDX_tool_calls_company_id").on(table.companyId),
    t.index("IDX_tool_calls_conversation_id").on(table.conversationId),
    t.index("IDX_tool_calls_message_id").on(table.messageId),
    t.index("IDX_tool_calls_tool_id").on(table.toolId),
  ],
);

// DEV_NOTE: One row per model call via AI Gateway (chat, judge, embed, rerank): source of truth for spend.
// conversation_id and eval_run_id both null = background job (indexing, clustering).
export const modelCalls = table(
  "model_calls",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    chatbotId: t.bigint("chatbot_id", { mode: "string" }), // → chatbots.id, null = background job
    chatbotUserId: t.bigint("chatbot_user_id", { mode: "string" }), // → chatbot_users.id
    conversationId: t.bigint("conversation_id", { mode: "string" }), // → conversations.id
    evalRunId: t.bigint("eval_run_id", { mode: "string" }), // → eval_runs.id
    turnId: t.text("turn_id"), // ULID from the Conversation DO
    taskType: t.text("task_type").$type<Schemas.ModelTaskTypeEnum>().notNull(), // route.intent, qa.answer, eval.judge…
    tier: t.smallint().$type<Schemas.ModelCallTierIntEnum>().notNull(),
    provider: t.text().$type<Schemas.ModelCallProvider>().notNull(), // company key provider, or workers_ai (embeddings)
    model: t.text().notNull(),
    gatewayLogId: t.text("gateway_log_id"),
    inputTokens: t.integer("input_tokens").notNull().default(0),
    outputTokens: t.integer("output_tokens"), // none for embed / rerank
    cachedTokens: t.integer("cached_tokens").notNull().default(0),
    costUsd: t.numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: t.integer("latency_ms"),
    wasEscalated: t.boolean("was_escalated").notNull().default(false),
    errorCode: t.text("error_code"),
    // DEV_NOTE: Where tokens and cost came from (ModelCallUsageStatusIntEnum). Pending rows are filled from the AI
    // Gateway log by the per-minute Cron; Unknown means cost 0 is not a real price.
    usageStatus: t
      .smallint("usage_status")
      .$type<Schemas.ModelCallUsageStatusIntEnum>()
      .notNull()
      .default(Schemas.ModelCallUsageStatusIntEnum.Reported),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_model_calls_public_id").on(table.publicId),
    // DEV_NOTE: The backfill sweep reads only Pending rows, oldest first; they are few and short-lived
    t
      .index("IDX_model_calls_created_at_pending")
      .on(table.createdAt)
      .where(sql`${table.usageStatus} = ${lit(Schemas.ModelCallUsageStatusIntEnum.Pending)}`),
    t.index("IDX_model_calls_company_id").on(table.companyId),
    t.index("IDX_model_calls_chatbot_id").on(table.chatbotId),
    t.index("IDX_model_calls_chatbot_user_id").on(table.chatbotUserId),
    t.index("IDX_model_calls_conversation_id").on(table.conversationId),
    t.index("IDX_model_calls_eval_run_id").on(table.evalRunId),
  ],
);

// DEV_NOTE: Thumbs up / down on one reply, one row per (reply, chatbot user).
export const feedback = table(
  "feedback",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    messageId: t.bigint("message_id", { mode: "string" }).notNull(), // → messages.id
    chatbotUserId: t.bigint("chatbot_user_id", { mode: "string" }).notNull(), // → chatbot_users.id
    rating: t.smallint().$type<Schemas.FeedbackRatingIntEnum>().notNull(),
    comment: t.text(),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_feedback_public_id").on(table.publicId),
    // DEV_NOTE: One rating per reply per chatbot user (M2-7): a second thumb replaces the first
    t
      .uniqueIndex("UNQ_feedback_message_id_chatbot_user_id")
      .on(table.messageId, table.chatbotUserId),
    t.index("IDX_feedback_company_id").on(table.companyId),
    t.index("IDX_feedback_chatbot_user_id").on(table.chatbotUserId),
  ],
);

// ─── Change requests ────────────────────────────────────────────────────────

// DEV_NOTE: A write the agent proposed to host data. Tool, version, risk and idempotency mode come via
// tool_call_id; the timeline lives in activity_log; the approver is the conversation's chatbot user.
// Purged = encrypted_changes IS NULL (purge job: undo_until < now() AND encrypted_changes IS NOT NULL).
export const changeRequests = table(
  "change_requests",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    conversationId: t.bigint("conversation_id", { mode: "string" }).notNull(), // → conversations.id
    toolCallId: t.bigint("tool_call_id", { mode: "string" }).notNull(), // → tool_calls.id
    status: t
      .smallint()
      .$type<Schemas.ChangeRequestStatusIntEnum>()
      .notNull()
      .default(Schemas.ChangeRequestStatusIntEnum.Proposed),
    encryptedChanges: t.bytea("encrypted_changes"),
    iv: t.bytea(),
    encryptionKeyVersion: t.integer("encryption_key_version"),
    summary: t.text().notNull(), // no values, for lists
    changeCount: t.integer("change_count").notNull(),
    wasEdited: t.boolean("was_edited").notNull().default(false),
    thinkExecutionId: t.text("think_execution_id"), // durable-pause id
    idempotencyKey: t.text("idempotency_key"),
    hostRef: t.text("host_ref"), // id returned by the host
    undoUntil: t.timestamp("undo_until", { withTimezone: true }),
    errorCode: t.text("error_code"),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_change_requests_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_change_requests_tool_call_id").on(table.toolCallId),
    t.index("IDX_change_requests_company_id").on(table.companyId),
    t.index("IDX_change_requests_conversation_id").on(table.conversationId),
    t
      .index("IDX_change_requests_undo_until_unpurged")
      .on(table.undoUntil)
      .where(sql`${table.encryptedChanges} IS NOT NULL`),
  ],
);

// ─── Files & knowledge ──────────────────────────────────────────────────────

// DEV_NOTE: Where knowledge comes from. Web sources (sitemap, url) need a url and a sync frequency; uploads have neither.
export const knowledgeSources = table(
  "knowledge_sources",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    type: t.smallint().$type<Schemas.KnowledgeSourceTypeIntEnum>().notNull(),
    url: t.text(),
    syncFrequency: t
      .smallint("sync_frequency")
      .$type<Schemas.KnowledgeSourceSyncFrequencyIntEnum>(),
    status: t
      .smallint()
      .$type<Schemas.KnowledgeSourceStatusIntEnum>()
      .notNull()
      .default(Schemas.KnowledgeSourceStatusIntEnum.Active),
    lastSyncedAt: t.timestamp("last_synced_at", { withTimezone: true }),
    // DEV_NOTE: The sync that owns the source (its workflow instance id), set at each claim. Only that sync may write
    // the source's documents, so a sync left behind by a pause / resume or a stale re-claim stops at its next step.
    // sync_heartbeat_at is set at the claim and on every sync step: a Syncing source whose heartbeat is older than
    // KNOWLEDGE_SYNC_STALE_MS has no live sync, and a Failed one is retried by the Cron after a backoff from it.
    syncRunId: t.text("sync_run_id"),
    syncHeartbeatAt: t.timestamp("sync_heartbeat_at", { withTimezone: true }),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system
    updatedBy: t.bigint("updated_by", { mode: "string" }), // → admins.id, null = system
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_knowledge_sources_public_id").on(table.publicId),
    t.check(
      "CHK_knowledge_sources_web_url",
      sql`(${table.type} IN (${lit(Schemas.KnowledgeSourceTypeIntEnum.Sitemap)}, ${lit(Schemas.KnowledgeSourceTypeIntEnum.Url)})) = (${table.url} IS NOT NULL)`,
    ),
    t.check(
      "CHK_knowledge_sources_web_sync_frequency",
      sql`(${table.type} IN (${lit(Schemas.KnowledgeSourceTypeIntEnum.Sitemap)}, ${lit(Schemas.KnowledgeSourceTypeIntEnum.Url)})) = (${table.syncFrequency} IS NOT NULL)`,
    ),
    t.index("IDX_knowledge_sources_company_id").on(table.companyId),
    t.index("IDX_knowledge_sources_created_by").on(table.createdBy),
    t.index("IDX_knowledge_sources_updated_by").on(table.updatedBy),
  ],
);

// DEV_NOTE: One document from a source. Bytes live in files (sha256 = bytes); content_hash = extracted text,
// so re-sync skips unchanged pages.
export const knowledgeDocuments = table(
  "knowledge_documents",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    knowledgeSourceId: t.bigint("knowledge_source_id", { mode: "string" }).notNull(), // → knowledge_sources.id
    fileId: t.bigint("file_id", { mode: "string" }).notNull(), // → files.id
    title: t.text(), // shown in citations
    sourceUrl: t.text("source_url"), // web sources only
    contentHash: t.text("content_hash"),
    indexStatus: t
      .smallint("index_status")
      .$type<Schemas.KnowledgeDocumentIndexStatusIntEnum>()
      .notNull()
      .default(Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending),
    lastSyncedAt: t.timestamp("last_synced_at", { withTimezone: true }),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_knowledge_documents_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_knowledge_documents_file_id").on(table.fileId),
    // DEV_NOTE: One document per web page of a source, so a page is never stored twice
    t
      .uniqueIndex("UNQ_knowledge_documents_knowledge_source_id_source_url")
      .on(table.knowledgeSourceId, table.sourceUrl)
      .where(sql`${table.sourceUrl} IS NOT NULL`),
    t.index("IDX_knowledge_documents_company_id").on(table.companyId),
    t.index("IDX_knowledge_documents_knowledge_source_id").on(table.knowledgeSourceId),
  ],
);

// DEV_NOTE: Registry of every R2 object. R2 key = t/{company public_id}/{file public_id}; purpose derives from
// owner_type. owner_* is polymorphic (conversation, eval_run, knowledge_document…). Purged with its owner.
export const files = table(
  "files",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    ownerType: t.text("owner_type").$type<Schemas.FileOwnerTypeEnum>().notNull(),
    ownerId: t.bigint("owner_id", { mode: "string" }).notNull(), // → <owner_type>.id
    filename: t.text(),
    mime: t.text().notNull(),
    sizeBytes: t.bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: t.text().notNull(),
    createdBy: t.bigint("created_by", { mode: "string" }), // → admins.id, null = system or the chatbot user
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_files_public_id").on(table.publicId),
    t.index("IDX_files_company_id").on(table.companyId),
    t.index("IDX_files_owner_id_owner_type").on(table.ownerId, table.ownerType),
    t.index("IDX_files_created_by").on(table.createdBy),
  ],
);

// DEV_NOTE: Searchable pieces of a document. knowledge_source_id is copied for the search filter.
// Hybrid search: HNSW on embedding + GIN on the generated tsv (heading weighted above body). Never mix
// embedding models in one search. Rebuilt on re-sync, so no public_id or updated_at.
export const knowledgeChunks = table(
  "knowledge_chunks",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    knowledgeDocumentId: t.bigint("knowledge_document_id", { mode: "string" }).notNull(), // → knowledge_documents.id
    knowledgeSourceId: t.bigint("knowledge_source_id", { mode: "string" }).notNull(), // → knowledge_sources.id
    chunkIndex: t.integer("chunk_index").notNull(),
    headingPath: t.text("heading_path"),
    text: t.text().notNull(),
    embedding: t.halfvec("embedding", { dimensions: 1024 }),
    embeddingModel: t.text("embedding_model"),
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(
        sql`setweight(to_tsvector('english', coalesce("heading_path", '')), 'A') || setweight(to_tsvector('english', "text"), 'B')`,
      ),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.index("IDX_knowledge_chunks_company_id").on(table.companyId),
    t.index("IDX_knowledge_chunks_knowledge_document_id").on(table.knowledgeDocumentId),
    t.index("IDX_knowledge_chunks_knowledge_source_id").on(table.knowledgeSourceId),
    t
      .index("IDX_knowledge_chunks_embedding")
      .using("hnsw", table.embedding.op("halfvec_cosine_ops")),
    t.index("IDX_knowledge_chunks_tsv").using("gin", table.tsv),
  ],
);

// DEV_NOTE: Groups of similar unanswered questions. Written by Cron (cluster + label) and admins (status);
// ingestion marks a cluster answered.
export const docGapClusters = table(
  "doc_gap_clusters",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    label: t.text().notNull(),
    centroid: t.halfvec("centroid", { dimensions: 1024 }).notNull(),
    questionCount: t.integer("question_count").notNull().default(0),
    status: t
      .smallint()
      .$type<Schemas.DocGapClusterStatusIntEnum>()
      .notNull()
      .default(Schemas.DocGapClusterStatusIntEnum.Open),
    answeredByDocumentId: t.bigint("answered_by_document_id", { mode: "string" }), // → knowledge_documents.id
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_doc_gap_clusters_public_id").on(table.publicId),
    t.index("IDX_doc_gap_clusters_company_id").on(table.companyId),
    t.index("IDX_doc_gap_clusters_answered_by_document_id").on(table.answeredByDocumentId),
  ],
);

// DEV_NOTE: One unanswered question as a PII-free rewrite. Purge nulls conversation_id + message_id; the gap stays.
export const docGaps = table(
  "doc_gaps",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    publicId: t.text("public_id").notNull(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    conversationId: t.bigint("conversation_id", { mode: "string" }), // → conversations.id
    messageId: t.bigint("message_id", { mode: "string" }), // → messages.id
    questionGeneric: t.text("question_generic").notNull(),
    signal: t.smallint().$type<Schemas.DocGapSignalIntEnum>().notNull(),
    embedding: t.halfvec("embedding", { dimensions: 1024 }),
    clusterId: t.bigint("cluster_id", { mode: "string" }), // → doc_gap_clusters.id
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: t.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_doc_gaps_public_id").on(table.publicId),
    t.uniqueIndex("UNQ_doc_gaps_message_id").on(table.messageId),
    t.index("IDX_doc_gaps_company_id").on(table.companyId),
    t.index("IDX_doc_gaps_conversation_id").on(table.conversationId),
    t.index("IDX_doc_gaps_cluster_id").on(table.clusterId),
  ],
);

// ─── Activity log & metrics ─────────────────────────────────────────────────

// DEV_NOTE: Append-only event tree, partitioned by month on created_at. The partitioning lives in the custom
// migration *_partition_activity_log; a partitioned table's primary key must include the partition key, hence
// (id, created_at). actor_* and entity_* are polymorphic. detail holds ids and reasons, never values.
export const activityLog = table(
  "activity_log",
  {
    id: t.bigint({ mode: "string" }).generatedAlwaysAsIdentity(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    actorType: t.smallint("actor_type").$type<Schemas.ActivityLogActorTypeIntEnum>().notNull(),
    actorId: t.bigint("actor_id", { mode: "string" }), // → admins.id / chatbot_users.id by actor_type
    entityType: t.text("entity_type").notNull(), // conversation, turn, change_request, chatbot_config…
    entityId: t.bigint("entity_id", { mode: "string" }), // → <entity_type>.id
    entityAction: t.text("entity_action").notNull(), // started, approved, verified, published…
    entityVersion: t.integer("entity_version"), // config / tool version
    parentLogId: t.bigint("parent_log_id", { mode: "string" }), // → activity_log.id (immediate parent)
    rootLogId: t.bigint("root_log_id", { mode: "string" }), // → activity_log.id, null = this row is a root
    detail: t.jsonb().notNull().default({}),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.primaryKey({ name: "activity_log_pkey", columns: [table.id, table.createdAt] }),
    t.index("IDX_activity_log_company_id").on(table.companyId),
    t.index("IDX_activity_log_actor_id").on(table.actorId),
    t.index("IDX_activity_log_entity_id").on(table.entityId),
    t.index("IDX_activity_log_parent_log_id").on(table.parentLogId),
    t.index("IDX_activity_log_root_log_id").on(table.rootLogId),
  ],
);

// DEV_NOTE: Daily per-company (chatbot_id null) and per-chatbot totals, rebuilt hourly from activity_log.
// Derived, never a source of truth; any (company, day) is re-runnable. NULLS NOT DISTINCT makes the
// company-wide row unique too.
export const activityRollups = table(
  "activity_rollups",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    chatbotId: t.bigint("chatbot_id", { mode: "string" }), // → chatbots.id, null = company-wide
    day: t.date().notNull(),
    metric: t.text().notNull(),
    value: t.numeric().notNull(),
  },
  (table) => [
    t
      .unique("UNQ_activity_rollups_company_id_chatbot_id_day_metric")
      .on(table.companyId, table.chatbotId, table.day, table.metric)
      .nullsNotDistinct(),
    t.index("IDX_activity_rollups_chatbot_id").on(table.chatbotId),
  ],
);

// DEV_NOTE: Transactional outbox: written in the same transaction as the change and its activity_log row,
// relayed to the Queue after commit (waitUntil) plus a Cron sweep of pending rows. Published rows are purged.
export const eventOutbox = table(
  "event_outbox",
  {
    id: t.bigint({ mode: "string" }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: t.bigint("company_id", { mode: "string" }).notNull(), // → companies.id
    activityLogId: t.bigint("activity_log_id", { mode: "string" }).notNull(), // → activity_log.id
    eventType: t.text("event_type").notNull(),
    dedupeKey: t.text("dedupe_key").notNull(),
    status: t
      .smallint()
      .$type<Schemas.EventOutboxStatusIntEnum>()
      .notNull()
      .default(Schemas.EventOutboxStatusIntEnum.Pending),
    attempts: t.smallint().notNull().default(0),
    lastError: t.text("last_error"),
    publishedAt: t.timestamp("published_at", { withTimezone: true }),
    createdAt: t.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    t.uniqueIndex("UNQ_event_outbox_company_id_dedupe_key").on(table.companyId, table.dedupeKey),
    t.uniqueIndex("UNQ_event_outbox_activity_log_id").on(table.activityLogId),
    t
      .index("IDX_event_outbox_pending_created_at")
      .on(table.createdAt)
      .where(sql`${table.status} = ${lit(Schemas.EventOutboxStatusIntEnum.Pending)}`),
  ],
);

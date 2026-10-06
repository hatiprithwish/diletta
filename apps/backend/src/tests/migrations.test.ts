import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Buffer } from "node:buffer";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  activityRollups,
  chatbotConfigs,
  companies,
  companyConnections,
  companyEncryptionKeys,
  companySecrets,
  evalCases,
  eventOutbox,
  knowledgeChunks,
  knowledgeSources,
  qualityIssues,
  toolDefinitions,
} from "@/db/tables";
import Utility from "@/utils/Utility";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Checks the M1-1 schema on the Neon staging branch: every table exists, constraints from the v0.15
// diagram reject bad rows, and activity_log routes rows to monthly partitions. It runs as the owner role
// (DATABASE_URL, BYPASSRLS) because it checks the schema itself; company isolation is rls.test.ts, as diletta_app.
// One fresh company per run; afterAll deletes every row this suite created.
// Reference columns hold placeholder ids: there are no foreign keys, so nothing checks them at the DB.
// DEV_NOTE: Test-only binding from apps/backend/.env, passed in by vitest.config.mts. Read through `in`
// narrowing so neither the worker's Env nor a test-only type has to declare it.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const ownerPool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
const db = drizzle({ client: ownerPool });
let companyId = "";

const EXPECTED_TABLES = [
  "activity_log",
  "activity_rollups",
  "admins",
  "change_requests",
  "chatbot_configs",
  "chatbot_user_secrets",
  "chatbot_users",
  "chatbots",
  "companies",
  "company_connections",
  "company_encryption_keys",
  "company_secrets",
  "conversations",
  "doc_gap_clusters",
  "doc_gaps",
  "eval_cases",
  "eval_results",
  "eval_runs",
  "event_outbox",
  "feedback",
  "files",
  "knowledge_chunks",
  "knowledge_documents",
  "knowledge_sources",
  "messages",
  "model_calls",
  "quality_issues",
  "roi_assumptions",
  "tool_calls",
  "tool_definitions",
];

const bytes = () => Buffer.from([1, 2, 3]);
// DEV_NOTE: Random placeholder for a reference column, so global unique indexes never collide with other runs
const fakeId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

// DEV_NOTE: drizzle wraps driver errors in DrizzleQueryError; the pg error (with the constraint name) is its cause
async function expectConstraintViolation(query: Promise<unknown>, constraint: string) {
  await expect(query).rejects.toMatchObject({ cause: { constraint } });
}

beforeAll(async () => {
  const created = await db
    .insert(companies)
    .values({ publicId: Utility.generatePublicId(), name: `Migration test ${crypto.randomUUID()}` })
    .returning({ id: companies.id });
  companyId = created[0]!.id;
});

afterAll(async () => {
  if (!companyId) {
    await ownerPool.end();
    return;
  }
  await db.delete(companyEncryptionKeys).where(eq(companyEncryptionKeys.companyId, companyId));
  await db.delete(companySecrets).where(eq(companySecrets.companyId, companyId));
  await db.delete(companyConnections).where(eq(companyConnections.companyId, companyId));
  await db.delete(chatbotConfigs).where(eq(chatbotConfigs.companyId, companyId));
  await db.delete(toolDefinitions).where(eq(toolDefinitions.companyId, companyId));
  await db.delete(evalCases).where(eq(evalCases.companyId, companyId));
  await db.delete(qualityIssues).where(eq(qualityIssues.companyId, companyId));
  await db.delete(knowledgeSources).where(eq(knowledgeSources.companyId, companyId));
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.companyId, companyId));
  await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
  await db.delete(activityRollups).where(eq(activityRollups.companyId, companyId));
  await db.delete(eventOutbox).where(eq(eventOutbox.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
  await ownerPool.end();
});

describe("schema shape", () => {
  it("has all 30 tables from the v0.15 diagram", async () => {
    const { rows } = await db.execute<{ name: string }>(sql`
      select c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    `);
    const names = rows.map((row) => row.name);
    for (const table of EXPECTED_TABLES) {
      expect(names).toContain(table);
    }
  });

  it("has no foreign keys", async () => {
    const { rows } = await db.execute<{ count: string }>(sql`
      select count(*)::text as count
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
      where n.nspname = 'public' and c.contype = 'f'
    `);
    expect(rows[0]?.count).toBe("0");
  });

  it("stores embeddings as halfvec(1024) with an HNSW cosine index on chunks", async () => {
    const { rows } = await db.execute<{ table: string; column: string; type: string }>(sql`
      select c.relname as "table", a.attname as "column", format_type(a.atttypid, a.atttypmod) as "type"
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where (c.relname, a.attname) in (('knowledge_chunks', 'embedding'), ('doc_gaps', 'embedding'), ('doc_gap_clusters', 'centroid'))
    `);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.type).toBe("halfvec(1024)");
    }

    const { rows: indexes } = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where indexname = 'IDX_knowledge_chunks_embedding'
    `);
    expect(indexes[0]?.indexdef).toMatch(/USING hnsw \(embedding halfvec_cosine_ops\)/);
  });

  it("generates the chunk tsvector from heading and text", async () => {
    const [chunk] = await db
      .insert(knowledgeChunks)
      .values({
        companyId,
        knowledgeDocumentId: fakeId(),
        knowledgeSourceId: fakeId(),
        chunkIndex: 0,
        headingPath: "Billing > Refunds",
        text: "Customers can request a refund within thirty days.",
      })
      .returning({ id: knowledgeChunks.id });

    const { rows } = await db.execute<{ byText: boolean; byHeading: boolean }>(sql`
      select tsv @@ plainto_tsquery('english', 'refund request') as "byText",
             tsv @@ plainto_tsquery('english', 'billing') as "byHeading"
      from knowledge_chunks where id = ${chunk!.id}
    `);
    expect(rows[0]).toEqual({ byText: true, byHeading: true });
  });
});

describe("activity_log partitions", () => {
  it("is partitioned by month on created_at, with a default partition", async () => {
    const { rows } = await db.execute<{ partition: string }>(sql`
      select c.relname as partition
      from pg_inherits i join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'activity_log'::regclass
    `);
    const partitions = rows.map((row) => row.partition);
    expect(partitions).toContain("activity_log_y2026m10");
    expect(partitions).toContain("activity_log_y2027m12");
    expect(partitions).toContain("activity_log_default");
    expect(partitions).toHaveLength(16);
  });

  it("routes rows to the month partition, and past the last month to default", async () => {
    const values = (createdAt: Date) => ({
      companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      entityType: "conversation",
      entityAction: "started",
      createdAt,
    });
    await db
      .insert(activityLog)
      .values([values(new Date("2027-03-15T12:00:00Z")), values(new Date("2030-01-01T00:00:00Z"))]);

    const { rows } = await db.execute<{ partition: string }>(sql`
      select tableoid::regclass::text as partition
      from activity_log where company_id = ${companyId} order by created_at
    `);
    expect(rows.map((row) => row.partition)).toEqual([
      "activity_log_y2027m03",
      "activity_log_default",
    ]);
  });
});

describe("CHECK constraints", () => {
  const secret = {
    publicId: "",
    companyId: "",
    encryptedSecret: bytes(),
    iv: bytes(),
    encryptionKeyVersion: 1,
    lastFourChars: "abcd",
  };

  it("ties a model key to a provider and a credential to a connection", async () => {
    await expectConstraintViolation(
      db.insert(companySecrets).values({
        ...secret,
        publicId: Utility.generatePublicId(),
        companyId,
        type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      }),
      "CHK_company_secrets_model_key_provider",
    );
    await expectConstraintViolation(
      db.insert(companySecrets).values({
        ...secret,
        publicId: Utility.generatePublicId(),
        companyId,
        type: Schemas.CompanySecretTypeIntEnum.ApiKey,
      }),
      "CHK_company_secrets_connection_id",
    );
  });

  it("requires a base URL unless the adapter is host-executed", async () => {
    await expectConstraintViolation(
      db.insert(companyConnections).values({
        publicId: Utility.generatePublicId(),
        companyId,
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        authType: "jwt_forward",
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        jwtIssuer: `https://issuer.test/${crypto.randomUUID()}`,
        allowedOrigins: ["https://host.test"],
      }),
      "CHK_company_connections_base_url",
    );
  });

  it("gives write tools a readback op and read tools none", async () => {
    const tool = (risk: Schemas.ToolDefinitionRiskIntEnum, readbackOp: unknown) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      connectionId: fakeId(),
      name: `tool_${crypto.randomUUID()}`,
      version: 1,
      description: "Test tool",
      risk,
      inputSchema: {},
      callOp: { method: "GET", path: "/records" },
      readbackOp,
      idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.None,
      approval: Schemas.ToolDefinitionApprovalIntEnum.Policy,
      source: Schemas.ToolDefinitionSourceIntEnum.Manual,
    });
    await expectConstraintViolation(
      db
        .insert(toolDefinitions)
        .values(tool(Schemas.ToolDefinitionRiskIntEnum.Read, { method: "GET" })),
      "CHK_tool_definitions_readback_op",
    );
    await expectConstraintViolation(
      db.insert(toolDefinitions).values(tool(Schemas.ToolDefinitionRiskIntEnum.Write, null)),
      "CHK_tool_definitions_readback_op",
    );
  });

  it("gives web knowledge sources a URL and sync frequency, and uploads neither", async () => {
    await expectConstraintViolation(
      db.insert(knowledgeSources).values({
        publicId: Utility.generatePublicId(),
        companyId,
        type: Schemas.KnowledgeSourceTypeIntEnum.Upload,
        url: "https://docs.test",
      }),
      "CHK_knowledge_sources_web_url",
    );
    await expectConstraintViolation(
      db.insert(knowledgeSources).values({
        publicId: Utility.generatePublicId(),
        companyId,
        type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap,
        url: "https://docs.test/sitemap.xml",
      }),
      "CHK_knowledge_sources_web_sync_frequency",
    );
  });

  it("ties quality issue source and status to feedback, creator and eval case", async () => {
    const issue = {
      publicId: "",
      companyId: "",
      conversationId: fakeId(),
    };
    await expectConstraintViolation(
      db.insert(qualityIssues).values({
        ...issue,
        publicId: Utility.generatePublicId(),
        companyId,
        source: Schemas.QualityIssueSourceIntEnum.User,
      }),
      "CHK_quality_issues_user_feedback_id",
    );
    await expectConstraintViolation(
      db.insert(qualityIssues).values({
        ...issue,
        publicId: Utility.generatePublicId(),
        companyId,
        source: Schemas.QualityIssueSourceIntEnum.Admin,
      }),
      "CHK_quality_issues_admin_created_by",
    );
    await expectConstraintViolation(
      db.insert(qualityIssues).values({
        ...issue,
        publicId: Utility.generatePublicId(),
        companyId,
        source: Schemas.QualityIssueSourceIntEnum.System,
        status: Schemas.QualityIssueStatusIntEnum.Converted,
      }),
      "CHK_quality_issues_converted_eval_case_id",
    );
  });

  it("keeps platform eval cases chatbot-free and their safety cases active", async () => {
    const testCase = {
      publicId: "",
      name: "Platform case",
      input: { messages: [] },
      expectations: {},
    };
    await expectConstraintViolation(
      db
        .insert(evalCases)
        .values({ ...testCase, publicId: Utility.generatePublicId(), chatbotId: fakeId() }),
      "CHK_eval_cases_platform_chatbot_id",
    );
    await expectConstraintViolation(
      db.insert(evalCases).values({
        ...testCase,
        publicId: Utility.generatePublicId(),
        isSafety: true,
        isActive: false,
      }),
      "CHK_eval_cases_platform_safety_active",
    );
  });
});

describe("partial unique indexes", () => {
  it("allows one active company key, plus a retiring one during rotation", async () => {
    const key = (version: number, status: Schemas.CompanyEncryptionKeyStatusIntEnum) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      version,
      encryptedKey: bytes(),
      masterKeyVersion: 1,
      status,
    });
    await db
      .insert(companyEncryptionKeys)
      .values(key(1, Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring));
    await db
      .insert(companyEncryptionKeys)
      .values(key(2, Schemas.CompanyEncryptionKeyStatusIntEnum.Active));
    await expectConstraintViolation(
      db
        .insert(companyEncryptionKeys)
        .values(key(3, Schemas.CompanyEncryptionKeyStatusIntEnum.Active)),
      "UNQ_company_encryption_keys_company_id_active",
    );
    await expectConstraintViolation(
      db
        .insert(companyEncryptionKeys)
        .values(key(2, Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring)),
      "UNQ_company_encryption_keys_company_id_version",
    );
  });

  it("allows one active model key per provider", async () => {
    const modelKey = (status: Schemas.CompanySecretStatusIntEnum) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      provider: "google",
      encryptedSecret: bytes(),
      iv: bytes(),
      encryptionKeyVersion: 1,
      lastFourChars: "abcd",
      status,
    });
    await db.insert(companySecrets).values(modelKey(Schemas.CompanySecretStatusIntEnum.Revoked));
    await db.insert(companySecrets).values(modelKey(Schemas.CompanySecretStatusIntEnum.Active));
    await expectConstraintViolation(
      db.insert(companySecrets).values(modelKey(Schemas.CompanySecretStatusIntEnum.Active)),
      "UNQ_company_secrets_company_id_provider_active",
    );
  });

  it("allows one published config per chatbot", async () => {
    const chatbotId = fakeId();
    const config = (configVersion: number, status: Schemas.ChatbotConfigStatusIntEnum) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotId,
      configVersion,
      status,
      body: {},
      bodyHash: "hash",
    });
    await db.insert(chatbotConfigs).values(config(1, Schemas.ChatbotConfigStatusIntEnum.Archived));
    await db.insert(chatbotConfigs).values(config(2, Schemas.ChatbotConfigStatusIntEnum.Published));
    await db.insert(chatbotConfigs).values(config(3, Schemas.ChatbotConfigStatusIntEnum.Draft));
    await expectConstraintViolation(
      db.insert(chatbotConfigs).values(config(4, Schemas.ChatbotConfigStatusIntEnum.Published)),
      "UNQ_chatbot_configs_chatbot_id_published",
    );
    await expectConstraintViolation(
      db.insert(chatbotConfigs).values(config(1, Schemas.ChatbotConfigStatusIntEnum.Draft)),
      "UNQ_chatbot_configs_chatbot_id_config_version",
    );
  });

  it("treats a null chatbot as one company-wide rollup row", async () => {
    const rollup = { companyId, day: "2026-10-05", metric: "conversations", value: "1" };
    await db.insert(activityRollups).values(rollup);
    await expectConstraintViolation(
      db.insert(activityRollups).values(rollup),
      "UNQ_activity_rollups_company_id_chatbot_id_day_metric",
    );
  });

  it("dedupes outbox events per company", async () => {
    const dedupeKey = `change_request:${fakeId()}:verified`;
    const event = (activityLogId: string) => ({
      companyId,
      activityLogId,
      eventType: "change_request.verified",
      dedupeKey,
    });
    await db.insert(eventOutbox).values(event(fakeId()));
    await expectConstraintViolation(
      db.insert(eventOutbox).values(event(fakeId())),
      "UNQ_event_outbox_company_id_dedupe_key",
    );
  });
});

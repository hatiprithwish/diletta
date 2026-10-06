import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Buffer } from "node:buffer";
import { inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import withPlatform from "@/db/withPlatform";
import {
  activityLog,
  activityRollups,
  admins,
  changeRequests,
  chatbotConfigs,
  chatbotUserSecrets,
  chatbotUsers,
  chatbots,
  companies,
  companyConnections,
  companyEncryptionKeys,
  companySecrets,
  conversations,
  docGapClusters,
  docGaps,
  evalCases,
  evalResults,
  evalRuns,
  eventOutbox,
  feedback,
  files,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  messages,
  modelCalls,
  qualityIssues,
  roiAssumptions,
  toolCalls,
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

// DEV_NOTE: The RLS suite (M1-3) on the Neon staging branch. Everything under test runs as diletta_app through
// the HYPERDRIVE binding, the role the worker uses, so only the policies stand between companies: the queries
// here deliberately skip the DAL's company_id filter. Fixtures and cleanup run as the owner (DATABASE_URL,
// BYPASSRLS). Two fresh companies per run, one row each per tenant table; every write under test is rolled
// back, and afterAll deletes every row this suite created.
const appDb = getDbClient(env);
// DEV_NOTE: Test-only binding from apps/backend/.env, passed in by vitest.config.mts. Read through `in`
// narrowing so neither the worker's Env nor a test-only type has to declare it.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let companyA = "";
let companyB = "";

const RLS_DENIED = "42501"; // insufficient_privilege: a row failed a policy's WITH CHECK

const pid = () => Utility.generatePublicId();
const uid = () => crypto.randomUUID();
// DEV_NOTE: Random placeholder for a reference column, so global unique indexes never collide with other runs
const fakeId = () => String(Math.floor(Math.random() * 1e15) + 1e15);
const bytes = () => Buffer.from([1, 2, 3]);
const vector = () => Array.from({ length: 1024 }, () => 0.5);

type Fixture = {
  name: string;
  insert: (client: NodePgDatabase, companyId: string) => Promise<{ id: string }[]>;
};

// DEV_NOTE: One minimal valid row per tenant table (NOT NULLs, CHECKs, unique indexes). Must list every table
// with a company_id column; the catalog test fails when a new tenant table is missing here.
const FIXTURES: Fixture[] = [
  {
    name: "activity_log",
    insert: (client, companyId) =>
      client
        .insert(activityLog)
        .values({
          companyId,
          actorType: Schemas.ActivityLogActorTypeIntEnum.System,
          entityType: "rls_test",
          entityAction: "started",
        })
        .returning({ id: activityLog.id }),
  },
  {
    name: "activity_rollups",
    insert: (client, companyId) =>
      client
        .insert(activityRollups)
        .values({ companyId, day: "2026-10-06", metric: `rls_${uid()}`, value: "1" })
        .returning({ id: activityRollups.id }),
  },
  {
    name: "admins",
    insert: (client, companyId) =>
      client
        .insert(admins)
        .values({ clerkUserId: `user_${uid()}`, companyId })
        .returning({ id: admins.id }),
  },
  {
    name: "change_requests",
    insert: (client, companyId) =>
      client
        .insert(changeRequests)
        .values({
          publicId: pid(),
          companyId,
          conversationId: fakeId(),
          toolCallId: fakeId(),
          summary: "RLS test",
          changeCount: 1,
        })
        .returning({ id: changeRequests.id }),
  },
  {
    name: "chatbot_configs",
    insert: (client, companyId) =>
      client
        .insert(chatbotConfigs)
        .values({
          publicId: pid(),
          companyId,
          chatbotId: fakeId(),
          configVersion: 1,
          body: {},
          bodyHash: "rls",
        })
        .returning({ id: chatbotConfigs.id }),
  },
  {
    name: "chatbot_user_secrets",
    insert: (client, companyId) =>
      client
        .insert(chatbotUserSecrets)
        .values({
          publicId: pid(),
          companyId,
          chatbotUserId: fakeId(),
          connectionId: fakeId(),
          type: "jwt_forward",
          encryptedSecret: bytes(),
          iv: bytes(),
          encryptionKeyVersion: 1,
        })
        .returning({ id: chatbotUserSecrets.id }),
  },
  {
    name: "chatbot_users",
    insert: (client, companyId) =>
      client
        .insert(chatbotUsers)
        .values({ companyId, hostUserId: `host_${uid()}` })
        .returning({ id: chatbotUsers.id }),
  },
  {
    name: "chatbots",
    insert: (client, companyId) =>
      client
        .insert(chatbots)
        .values({ publicId: pid(), companyId, name: "RLS test" })
        .returning({ id: chatbots.id }),
  },
  {
    name: "company_connections",
    insert: (client, companyId) =>
      client
        .insert(companyConnections)
        .values({
          publicId: pid(),
          companyId,
          environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
          baseUrl: "https://host.example.com",
          authType: "jwt_forward",
          authConfig: {},
          credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
          jwtIssuer: `https://${uid()}.example.com`,
          allowedOrigins: ["https://host.example.com"],
        })
        .returning({ id: companyConnections.id }),
  },
  {
    name: "company_encryption_keys",
    // DEV_NOTE: Retiring, so moving a row between companies can't trip the one-active-key index first
    insert: (client, companyId) =>
      client
        .insert(companyEncryptionKeys)
        .values({
          publicId: pid(),
          companyId,
          version: Math.floor(Math.random() * 1e9) + 1,
          encryptedKey: bytes(),
          masterKeyVersion: 1,
          status: Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
        })
        .returning({ id: companyEncryptionKeys.id }),
  },
  {
    name: "company_secrets",
    insert: (client, companyId) =>
      client
        .insert(companySecrets)
        .values({
          publicId: pid(),
          companyId,
          type: Schemas.CompanySecretTypeIntEnum.ModelKey,
          provider: `rls_${uid()}`,
          encryptedSecret: bytes(),
          iv: bytes(),
          encryptionKeyVersion: 1,
          lastFourChars: "abcd",
        })
        .returning({ id: companySecrets.id }),
  },
  {
    name: "conversations",
    insert: (client, companyId) =>
      client
        .insert(conversations)
        .values({ publicId: pid(), companyId, chatbotUserId: fakeId(), chatbotId: fakeId() })
        .returning({ id: conversations.id }),
  },
  {
    name: "doc_gap_clusters",
    insert: (client, companyId) =>
      client
        .insert(docGapClusters)
        .values({ publicId: pid(), companyId, label: "RLS test", centroid: vector() })
        .returning({ id: docGapClusters.id }),
  },
  {
    name: "doc_gaps",
    insert: (client, companyId) =>
      client
        .insert(docGaps)
        .values({
          publicId: pid(),
          companyId,
          questionGeneric: "RLS test?",
          signal: Schemas.DocGapSignalIntEnum.Idk,
        })
        .returning({ id: docGaps.id }),
  },
  {
    name: "eval_cases",
    insert: (client, companyId) =>
      client
        .insert(evalCases)
        .values({
          publicId: pid(),
          companyId,
          chatbotId: fakeId(),
          name: "RLS test",
          input: {},
          expectations: {},
        })
        .returning({ id: evalCases.id }),
  },
  {
    name: "eval_results",
    insert: (client, companyId) =>
      client
        .insert(evalResults)
        .values({
          companyId,
          evalRunId: fakeId(),
          evalCaseId: fakeId(),
          attempt: 1,
          hasPassed: true,
        })
        .returning({ id: evalResults.id }),
  },
  {
    name: "eval_runs",
    insert: (client, companyId) =>
      client
        .insert(evalRuns)
        .values({
          publicId: pid(),
          companyId,
          chatbotConfigId: fakeId(),
          trigger: Schemas.EvalRunTriggerIntEnum.Manual,
          harnessVersion: "rls",
          k: 1,
        })
        .returning({ id: evalRuns.id }),
  },
  {
    name: "event_outbox",
    insert: (client, companyId) =>
      client
        .insert(eventOutbox)
        .values({ companyId, activityLogId: fakeId(), eventType: "rls_test", dedupeKey: uid() })
        .returning({ id: eventOutbox.id }),
  },
  {
    name: "feedback",
    insert: (client, companyId) =>
      client
        .insert(feedback)
        .values({
          publicId: pid(),
          companyId,
          messageId: fakeId(),
          chatbotUserId: fakeId(),
          rating: Schemas.FeedbackRatingIntEnum.Up,
        })
        .returning({ id: feedback.id }),
  },
  {
    name: "files",
    insert: (client, companyId) =>
      client
        .insert(files)
        .values({
          publicId: pid(),
          companyId,
          ownerType: "conversation",
          ownerId: fakeId(),
          mime: "text/plain",
          sizeBytes: 1,
          sha256: "rls",
        })
        .returning({ id: files.id }),
  },
  {
    name: "knowledge_chunks",
    insert: (client, companyId) =>
      client
        .insert(knowledgeChunks)
        .values({
          companyId,
          knowledgeDocumentId: fakeId(),
          knowledgeSourceId: fakeId(),
          chunkIndex: 0,
          text: "RLS test",
        })
        .returning({ id: knowledgeChunks.id }),
  },
  {
    name: "knowledge_documents",
    insert: (client, companyId) =>
      client
        .insert(knowledgeDocuments)
        .values({ publicId: pid(), companyId, knowledgeSourceId: fakeId(), fileId: fakeId() })
        .returning({ id: knowledgeDocuments.id }),
  },
  {
    name: "knowledge_sources",
    insert: (client, companyId) =>
      client
        .insert(knowledgeSources)
        .values({ publicId: pid(), companyId, type: Schemas.KnowledgeSourceTypeIntEnum.Upload })
        .returning({ id: knowledgeSources.id }),
  },
  {
    name: "messages",
    insert: (client, companyId) =>
      client
        .insert(messages)
        .values({
          publicId: pid(),
          companyId,
          conversationId: fakeId(),
          sessionMessageId: uid(),
          turnId: uid(),
          role: Schemas.MessageRoleIntEnum.User,
        })
        .returning({ id: messages.id }),
  },
  {
    name: "model_calls",
    insert: (client, companyId) =>
      client
        .insert(modelCalls)
        .values({
          publicId: pid(),
          companyId,
          taskType: "qa.answer",
          tier: Schemas.ModelCallTierIntEnum.Small,
          provider: "google",
          model: "rls-test",
        })
        .returning({ id: modelCalls.id }),
  },
  {
    name: "quality_issues",
    insert: (client, companyId) =>
      client
        .insert(qualityIssues)
        .values({
          publicId: pid(),
          companyId,
          conversationId: fakeId(),
          source: Schemas.QualityIssueSourceIntEnum.System,
        })
        .returning({ id: qualityIssues.id }),
  },
  {
    name: "roi_assumptions",
    insert: (client, companyId) =>
      client
        .insert(roiAssumptions)
        .values({
          publicId: pid(),
          companyId,
          taskType: "rls_test",
          manualMinutes: "5",
          effectiveFrom: "2026-10-01",
        })
        .returning({ id: roiAssumptions.id }),
  },
  {
    name: "tool_calls",
    insert: (client, companyId) =>
      client
        .insert(toolCalls)
        .values({
          publicId: pid(),
          companyId,
          conversationId: fakeId(),
          turnId: uid(),
          toolId: fakeId(),
          toolVersion: 1,
          status: Schemas.ToolCallStatusIntEnum.Ok,
        })
        .returning({ id: toolCalls.id }),
  },
  {
    name: "tool_definitions",
    insert: (client, companyId) =>
      client
        .insert(toolDefinitions)
        .values({
          publicId: pid(),
          companyId,
          connectionId: fakeId(),
          name: `rls_${uid()}`,
          version: 1,
          description: "RLS test",
          risk: Schemas.ToolDefinitionRiskIntEnum.Read,
          inputSchema: {},
          callOp: {},
          idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.None,
          approval: Schemas.ToolDefinitionApprovalIntEnum.Never,
          source: Schemas.ToolDefinitionSourceIntEnum.Manual,
        })
        .returning({ id: toolDefinitions.id }),
  },
];

// Rows created per table in beforeAll: one for company A, one for company B
const rowsA = new Map<string, string>();
const rowsB = new Map<string, string>();
let operatorAdminId = "";
let platformCaseId = "";

// ─── Outcome helpers ────────────────────────────────────────────────────────

// DEV_NOTE: A statement's outcome as one comparable string: "ok:<ids returned, ascending>" or "denied" (RLS
// WITH CHECK) or "error:<pg code>". drizzle wraps driver errors in DrizzleQueryError; the pg error is its cause.
function errorCode(error: unknown): string {
  const source = error instanceof Error && error.cause ? error.cause : error;
  if (source && typeof source === "object" && "code" in source && typeof source.code === "string") {
    return source.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function ok(...ids: string[]): string {
  return `ok:${[...ids].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)).join(",")}`;
}

async function settle(pending: Promise<{ id: string }[]>): Promise<string> {
  try {
    const rows = await pending;
    return ok(...rows.map((row) => row.id));
  } catch (error) {
    const code = errorCode(error);
    return code === RLS_DENIED ? "denied" : `error:${code}`;
  }
}

// DEV_NOTE: Runs one statement inside withTenant / withPlatform and always rolls it back (the outcome travels
// out as the TenantRollbackError message), so a write a policy wrongly allowed never persists.
async function asTenant(
  companyId: string,
  run: (tx: NodePgDatabase) => Promise<{ id: string }[]>,
): Promise<string> {
  const result = await withTenant(appDb, companyId, async (tx) => {
    throw new TenantRollbackError(await settle(run(tx)));
  });
  return result.message ?? "";
}

async function asPlatform(run: (tx: NodePgDatabase) => Promise<{ id: string }[]>): Promise<string> {
  const result = await withPlatform(appDb, async (tx) => {
    throw new TenantRollbackError(await settle(run(tx)));
  });
  return result.message ?? "";
}

async function returningIds(client: NodePgDatabase, query: SQL): Promise<{ id: string }[]> {
  const { rows } = await client.execute<{ id: string }>(query);
  return rows;
}

const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

const selectIds = (client: NodePgDatabase, table: string, ids: string[]) =>
  returningIds(
    client,
    sql`select id::text as id from ${sql.identifier(table)} where id in (${idList(ids)})`,
  );

const touch = (client: NodePgDatabase, table: string, id: string) =>
  returningIds(
    client,
    sql`update ${sql.identifier(table)} set company_id = company_id where id = ${id} returning id::text as id`,
  );

const moveTo = (client: NodePgDatabase, table: string, id: string, companyId: string) =>
  returningIds(
    client,
    sql`update ${sql.identifier(table)} set company_id = ${companyId} where id = ${id} returning id::text as id`,
  );

const remove = (client: NodePgDatabase, table: string, id: string) =>
  returningIds(
    client,
    sql`delete from ${sql.identifier(table)} where id = ${id} returning id::text as id`,
  );

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  if (!ownerDatabaseUrl) {
    throw new Error(
      "Set DATABASE_URL in apps/backend/.env (Neon staging, owner role, direct host)",
    );
  }
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: pid(), name: `RLS company A ${uid()}` },
        { publicId: pid(), name: `RLS company B ${uid()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;

    for (const fixture of FIXTURES) {
      const [rowA] = await fixture.insert(ownerDb, companyA);
      const [rowB] = await fixture.insert(ownerDb, companyB);
      rowsA.set(fixture.name, rowA!.id);
      rowsB.set(fixture.name, rowB!.id);
    }

    const [operator] = await ownerDb
      .insert(admins)
      .values({ clerkUserId: `user_${uid()}`, companyId: null })
      .returning({ id: admins.id });
    operatorAdminId = operator!.id;

    const [platformCase] = await ownerDb
      .insert(evalCases)
      .values({ publicId: pid(), name: "RLS platform case", input: {}, expectations: {} })
      .returning({ id: evalCases.id });
    platformCaseId = platformCase!.id;
  });
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  await appDb.$client.end();
  await withOwnerDb(async (ownerDb) => {
    if (companyIds.length > 0) {
      for (const fixture of FIXTURES) {
        await ownerDb.execute(
          sql`delete from ${sql.identifier(fixture.name)} where company_id in (${idList(companyIds)})`,
        );
      }
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    }
    if (operatorAdminId) await ownerDb.delete(admins).where(inArray(admins.id, [operatorAdminId]));
    if (platformCaseId) {
      await ownerDb.delete(evalCases).where(inArray(evalCases.id, [platformCaseId]));
    }
  });
});

describe("app role and catalog", () => {
  it("runs the worker connection as diletta_app, which can't bypass RLS or reach the migrations journal", async () => {
    const { rows } = await appDb.execute<{
      role: string;
      isSuperuser: boolean;
      canBypassRls: boolean;
      isNeonSuperuser: boolean;
      canReadJournal: boolean;
    }>(sql`
      select current_user as role, r.rolsuper as "isSuperuser", r.rolbypassrls as "canBypassRls",
        coalesce((select pg_has_role(current_user, oid, 'member') from pg_roles where rolname = 'neon_superuser'), false)
          as "isNeonSuperuser",
        has_schema_privilege('drizzle', 'USAGE') as "canReadJournal"
      from pg_roles r where r.rolname = current_user
    `);
    expect(rows[0]).toEqual({
      role: "diletta_app",
      isSuperuser: false,
      canBypassRls: false,
      isNeonSuperuser: false,
      canReadJournal: false,
    });
  });

  it("covers every table with a company_id column in this suite", async () => {
    const { rows } = await appDb.execute<{ name: string }>(sql`
      select c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    `);
    const tenantTables = rows.map((row) => row.name).sort();
    expect(tenantTables).toEqual(FIXTURES.map((fixture) => fixture.name).sort());
  });

  it("forces RLS with policies on every table the app can reach, except users, and grants no partition", async () => {
    const { rows } = await appDb.execute<{
      name: string;
      isPartition: boolean;
      isGranted: boolean;
      hasRls: boolean;
      isForced: boolean;
      policyCount: number;
    }>(sql`
      select c.relname as name, c.relispartition as "isPartition",
        has_table_privilege(c.oid, 'SELECT, INSERT, UPDATE, DELETE') as "isGranted",
        c.relrowsecurity as "hasRls", c.relforcerowsecurity as "isForced",
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as "policyCount"
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
    `);

    const partitions = rows.filter((row) => row.isPartition);
    expect(partitions.length).toBeGreaterThan(0);
    for (const partition of partitions) {
      expect({ name: partition.name, isGranted: partition.isGranted }).toEqual({
        name: partition.name,
        isGranted: false,
      });
    }

    for (const table of rows.filter((row) => !row.isPartition)) {
      const expected =
        table.name === "users"
          ? { isGranted: true, hasRls: false }
          : { isGranted: true, hasRls: true, isForced: true, hasPolicies: true };
      const actual =
        table.name === "users"
          ? { isGranted: table.isGranted, hasRls: table.hasRls }
          : {
              isGranted: table.isGranted,
              hasRls: table.hasRls,
              isForced: table.isForced,
              hasPolicies: table.policyCount >= 2,
            };
      expect({ name: table.name, ...actual }).toEqual({ name: table.name, ...expected });
    }
  });
});

describe.each(FIXTURES)("RLS on $name", (fixture) => {
  const table = fixture.name;

  it("stops company B reading, changing or deleting company A's row", async () => {
    const rowA = rowsA.get(table)!;
    const rowB = rowsB.get(table)!;

    expect(await asTenant(companyB, (tx) => selectIds(tx, table, [rowA, rowB]))).toBe(ok(rowB));
    expect(await asTenant(companyB, (tx) => touch(tx, table, rowA))).toBe(ok());
    expect(await asTenant(companyB, (tx) => remove(tx, table, rowA))).toBe(ok());
  });

  it("stops company B writing a row into company A", async () => {
    const rowB = rowsB.get(table)!;

    expect(await asTenant(companyB, (tx) => fixture.insert(tx, companyA))).toBe("denied");
    expect(await asTenant(companyB, (tx) => moveTo(tx, table, rowB, companyA))).toBe("denied");
  });

  it("shows and accepts nothing without a company context", async () => {
    const rowA = rowsA.get(table)!;
    const rowB = rowsB.get(table)!;

    expect(await settle(selectIds(appDb, table, [rowA, rowB]))).toBe(ok());
    expect(await settle(fixture.insert(appDb, companyA))).toBe("denied");
  });

  it("lets company A use its own row, and the platform context reach both", async () => {
    const rowA = rowsA.get(table)!;
    const rowB = rowsB.get(table)!;

    expect(await asTenant(companyA, (tx) => selectIds(tx, table, [rowA, rowB]))).toBe(ok(rowA));
    expect(await asTenant(companyA, (tx) => touch(tx, table, rowA))).toBe(ok(rowA));
    expect(await asTenant(companyA, (tx) => fixture.insert(tx, companyA))).toMatch(/^ok:\d+$/);
    expect(await asPlatform((tx) => selectIds(tx, table, [rowA, rowB]))).toBe(ok(rowA, rowB));
  });
});

describe("RLS on companies (tenancy root)", () => {
  const selectCompanies = (client: NodePgDatabase) =>
    returningIds(
      client,
      sql`select id::text as id from companies where id in (${companyA}, ${companyB})`,
    );
  const renameCompany = (client: NodePgDatabase, id: string) =>
    returningIds(
      client,
      sql`update companies set name = name where id = ${id} returning id::text as id`,
    );
  const insertCompany = (client: NodePgDatabase) =>
    client
      .insert(companies)
      .values({ publicId: pid(), name: `RLS insert ${uid()}` })
      .returning({ id: companies.id });

  it("lets a tenant read and update only its own company, never create or delete one", async () => {
    expect(await asTenant(companyA, selectCompanies)).toBe(ok(companyA));
    expect(await asTenant(companyA, (tx) => renameCompany(tx, companyB))).toBe(ok());
    expect(await asTenant(companyA, (tx) => renameCompany(tx, companyA))).toBe(ok(companyA));
    expect(await asTenant(companyA, insertCompany)).toBe("denied");
    expect(
      await asTenant(companyA, (tx) =>
        returningIds(
          tx,
          sql`delete from companies where id = ${companyA} returning id::text as id`,
        ),
      ),
    ).toBe(ok());
  });

  it("lets the platform context list and create companies", async () => {
    expect(await asPlatform(selectCompanies)).toBe(ok(companyA, companyB));
    expect(await asPlatform(insertCompany)).toMatch(/^ok:\d+$/);
  });
});

describe("RLS on admins (operators)", () => {
  it("hides operators from company admins and stops a tenant creating one", async () => {
    const adminA = rowsA.get("admins")!;

    expect(
      await asTenant(companyA, (tx) => selectIds(tx, "admins", [adminA, operatorAdminId])),
    ).toBe(ok(adminA));
    expect(
      await asTenant(companyA, (tx) =>
        tx
          .insert(admins)
          .values({ clerkUserId: `user_${uid()}`, companyId: null })
          .returning({ id: admins.id }),
      ),
    ).toBe("denied");
    expect(
      await asTenant(companyA, (tx) =>
        returningIds(
          tx,
          sql`update admins set company_id = null where id = ${adminA} returning id::text as id`,
        ),
      ),
    ).toBe("denied");
  });

  it("shows the platform context every admin, operators included", async () => {
    const adminA = rowsA.get("admins")!;
    const adminB = rowsB.get("admins")!;

    expect(
      await asPlatform((tx) => selectIds(tx, "admins", [adminA, adminB, operatorAdminId])),
    ).toBe(ok(adminA, adminB, operatorAdminId));
  });
});

describe("RLS on eval_cases (platform cases)", () => {
  const renameCase = (client: NodePgDatabase, id: string) =>
    returningIds(
      client,
      sql`update eval_cases set name = name where id = ${id} returning id::text as id`,
    );

  it("lets every tenant read platform cases but never write them", async () => {
    const caseA = rowsA.get("eval_cases")!;

    expect(
      await asTenant(companyA, (tx) => selectIds(tx, "eval_cases", [caseA, platformCaseId])),
    ).toBe(ok(caseA, platformCaseId));
    expect(
      await asTenant(companyB, (tx) => selectIds(tx, "eval_cases", [caseA, platformCaseId])),
    ).toBe(ok(platformCaseId));
    expect(await asTenant(companyA, (tx) => renameCase(tx, platformCaseId))).toBe(ok());
    expect(await asTenant(companyA, (tx) => remove(tx, "eval_cases", platformCaseId))).toBe(ok());
    expect(
      await asTenant(companyA, (tx) =>
        tx
          .insert(evalCases)
          .values({ publicId: pid(), name: "RLS forged", input: {}, expectations: {} })
          .returning({ id: evalCases.id }),
      ),
    ).toBe("denied");
  });

  it("lets the platform context edit platform cases", async () => {
    expect(await asPlatform((tx) => renameCase(tx, platformCaseId))).toBe(ok(platformCaseId));
  });
});

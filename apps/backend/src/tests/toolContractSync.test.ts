import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  chatbotConfigs,
  chatbots,
  companies,
  companyConnections,
  eventOutbox,
  qualityIssues,
  toolDefinitions,
} from "@/db/tables";
import ToolContractSyncRepo from "@/repositories/ToolContractSyncRepo";
import Utility from "@/utils/Utility";
import { testHostToolColumns } from "@/tests/helpers/testHost";
import { SPEC_URL, serveSpec, specFor } from "@/tests/helpers/toolSpec";
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: ADR 0009 against the Neon staging branch. Companies, connections, tools and a Published config are owner
// fixtures; ToolContractSyncRepo runs as diletta_app (HYPERDRIVE), so RLS applies. The host's spec is served from memory.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const SUITE_TIMEOUT_MS = 120_000;
const TOOL = "update_record";
const createdCompanyIds: string[] = [];
let ownerPool: Pool | null = null;

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

interface Tenant {
  companyId: string;
  connectionPublicId: string;
  chatbotId: string;
}

// DEV_NOTE: The spec the host serves for update_record: its amount is an integer here, a number in the stored version
function hostSpec(overrides: { omitTool?: boolean; amountType?: string } = {}) {
  const callOp = testHostToolColumns(TOOL).callOp as Schemas.ToolOps["callOp"];
  if (overrides.omitTool) return specFor([]);
  return specFor([{ name: TOOL, ops: { callOp } }], () => ({
    requestBody: {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { amount: { type: overrides.amountType ?? "integer" } },
            required: ["amount"],
          },
        },
      },
    },
  }));
}

async function createTenant(): Promise<Tenant> {
  return await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .insert(companies)
      .values({
        publicId: Utility.generatePublicId(),
        name: `Contract sync ${crypto.randomUUID()}`,
      })
      .returning({ id: companies.id });
    const companyId = company?.id ?? "";
    createdCompanyIds.push(companyId);
    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        name: "Records bot",
        isDefault: true,
      })
      .returning({ id: chatbots.id });
    const [connection] = await ownerDb
      .insert(companyConnections)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        baseUrl: "https://host.example.com",
        authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
        allowedOrigins: ["https://app.example.com"],
        openapiUrl: SPEC_URL,
      })
      .returning({ id: companyConnections.id, publicId: companyConnections.publicId });
    await ownerDb.insert(toolDefinitions).values({
      publicId: Utility.generatePublicId(),
      companyId,
      connectionId: connection?.id ?? "",
      version: 1,
      status: Schemas.ToolDefinitionStatusIntEnum.Active,
      ...testHostToolColumns(TOOL),
      operationId: TOOL,
      contractHash: "stale",
    });
    const body = Schemas.normalizeConfigBody({
      persona: { instructions: "You help the user keep their records up to date." },
      procedures: [],
      tools: [{ name: TOOL, version: 1 }],
      approvalRules: [],
      routing: {
        small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
        mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
        top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
        defaultTier: Schemas.ModelTierEnum.Mid,
      },
      knowledge: { sourceIds: [] },
      widget: { greeting: "Hi, what do you need?", suggestions: [] },
    });
    if (!body.isSuccess || !body.body) throw new Error(body.message);
    await ownerDb.insert(chatbotConfigs).values({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotId: chatbot?.id ?? "",
      configVersion: 1,
      schemaVersion: body.schemaVersion ?? 1,
      status: Schemas.ChatbotConfigStatusIntEnum.Published,
      body: body.body,
      bodyHash: await Utility.sha256Hex(Utility.stableStringify(body.body)),
    });
    return {
      companyId,
      connectionPublicId: connection?.publicId ?? "",
      chatbotId: chatbot?.id ?? "",
    };
  });
}

const sync = (tenant: Tenant, isDryRun = false) =>
  new ToolContractSyncRepo(env).syncOne({
    companyId: tenant.companyId,
    connectionPublicId: tenant.connectionPublicId,
    isDryRun,
  });

async function versions(tenant: Tenant) {
  return await withOwnerDb((ownerDb) =>
    ownerDb
      .select({
        version: toolDefinitions.version,
        status: toolDefinitions.status,
        inputSchema: toolDefinitions.inputSchema,
        contractHash: toolDefinitions.contractHash,
      })
      .from(toolDefinitions)
      .where(eq(toolDefinitions.companyId, tenant.companyId))
      .orderBy(toolDefinitions.version),
  );
}

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  try {
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
      await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
      await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
      await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
      await ownerDb
        .delete(companyConnections)
        .where(inArray(companyConnections.companyId, companyIds));
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await ownerPool?.end();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolContractSyncRepo", { timeout: SUITE_TIMEOUT_MS }, () => {
  it("creates a new Active version where the spec changed, a draft that uses it and a Tool update issue", async () => {
    const tenant = await createTenant();
    serveSpec(() => hostSpec());

    const result = await sync(tenant);
    expect(result.isSuccess, result.message).toBe(true);
    expect(result.changes).toEqual([
      expect.objectContaining({ name: TOOL, fromVersion: 1, toVersion: 2 }),
    ]);

    const rows = await versions(tenant);
    expect(rows.map((row) => [row.version, row.status])).toEqual([
      [1, Schemas.ToolDefinitionStatusIntEnum.Active],
      [2, Schemas.ToolDefinitionStatusIntEnum.Active],
    ]);
    const properties = (rows[1]?.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(properties.amount).toEqual({ type: "integer" });

    // The live setup keeps v1; a new Draft pins v2
    const configs = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({
          status: chatbotConfigs.status,
          body: chatbotConfigs.body,
          version: chatbotConfigs.configVersion,
        })
        .from(chatbotConfigs)
        .where(eq(chatbotConfigs.companyId, tenant.companyId))
        .orderBy(chatbotConfigs.configVersion),
    );
    expect(configs.map((config) => config.status)).toEqual([
      Schemas.ChatbotConfigStatusIntEnum.Published,
      Schemas.ChatbotConfigStatusIntEnum.Draft,
    ]);
    expect((configs[0]?.body as { tools: unknown }).tools).toEqual([{ name: TOOL, version: 1 }]);
    expect((configs[1]?.body as { tools: unknown }).tools).toEqual([{ name: TOOL, version: 2 }]);

    const issues = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({
          issueType: qualityIssues.issueType,
          chatbotId: qualityIssues.chatbotId,
          note: qualityIssues.note,
        })
        .from(qualityIssues)
        .where(eq(qualityIssues.companyId, tenant.companyId)),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      issueType: Schemas.QualityIssueTypeIntEnum.ToolUpdate,
      chatbotId: tenant.chatbotId,
    });
    expect(issues[0]?.note).toContain(TOOL);

    const connection = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({
          hash: companyConnections.openapiSpecHash,
          syncedAt: companyConnections.openapiSyncedAt,
          failure: companyConnections.openapiFailure,
        })
        .from(companyConnections)
        .where(eq(companyConnections.publicId, tenant.connectionPublicId)),
    );
    expect(connection[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(connection[0]?.syncedAt).not.toBeNull();
    expect(connection[0]?.failure).toBeNull();
  });

  it("changes nothing the second time, and a dry run reads everything and writes nothing", async () => {
    const tenant = await createTenant();
    serveSpec(() => hostSpec());

    const dry = await sync(tenant, true);
    expect(dry).toMatchObject({ isSuccess: true, isDryRun: true });
    expect(dry.changes).toEqual([expect.objectContaining({ name: TOOL, toVersion: null })]);
    expect(await versions(tenant)).toHaveLength(1);

    await sync(tenant);
    const again = await sync(tenant);
    expect(again.isSuccess).toBe(true);
    expect(again.changes).toEqual([]);
    expect(await versions(tenant)).toHaveLength(2);
  });

  it("adds to the open draft instead of making a second, and leaves a version in testing alone", async () => {
    const tenant = await createTenant();
    serveSpec(() => hostSpec());
    await sync(tenant);

    // The spec moves again: the open draft (pinning v2) is bumped to v3 in place
    serveSpec(() => hostSpec({ amountType: "string" }));
    const second = await sync(tenant);
    expect(second.changes).toEqual([expect.objectContaining({ fromVersion: 2, toVersion: 3 })]);
    const configs = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ status: chatbotConfigs.status, body: chatbotConfigs.body })
        .from(chatbotConfigs)
        .where(
          and(
            eq(chatbotConfigs.companyId, tenant.companyId),
            eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Draft),
          ),
        ),
    );
    expect(configs).toHaveLength(1);
    expect((configs[0]?.body as { tools: unknown }).tools).toEqual([{ name: TOOL, version: 3 }]);
  });

  it("keeps the tools and alerts when the spec has no operation for a tool", async () => {
    const tenant = await createTenant();
    serveSpec(() => hostSpec({ omitTool: true }));

    const result = await sync(tenant);
    expect(result.failure).toBe(Schemas.ToolContractSyncFailureIntEnum.OperationMissing);
    expect(result.problems?.[0]).toContain(TOOL);
    expect(await versions(tenant)).toHaveLength(1);
    const failure = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ failure: companyConnections.openapiFailure })
        .from(companyConnections)
        .where(eq(companyConnections.publicId, tenant.connectionPublicId)),
    );
    expect(failure[0]?.failure).toBe(Schemas.ToolContractSyncFailureIntEnum.OperationMissing);
  });

  it("fails without changing anything when the spec can't be fetched or isn't OpenAPI", async () => {
    const tenant = await createTenant();
    serveSpec(() => null);
    expect(await sync(tenant)).toMatchObject({
      isSuccess: false,
      failure: Schemas.ToolContractSyncFailureIntEnum.FetchFailed,
    });
    serveSpec(() => ({ swagger: "2.0", paths: {} }));
    expect(await sync(tenant)).toMatchObject({
      isSuccess: false,
      failure: Schemas.ToolContractSyncFailureIntEnum.NotOpenApi,
    });
    expect(await versions(tenant)).toHaveLength(1);
  });

  it("never reads or moves another company's tools, and 404s a connection that isn't the company's", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    serveSpec(() => hostSpec());
    const crossed = await new ToolContractSyncRepo(env).syncOne({
      companyId: tenantB.companyId,
      connectionPublicId: tenantA.connectionPublicId,
      isDryRun: false,
    });
    expect(crossed).toMatchObject({ isSuccess: false, isNotFound: true });
    expect(await versions(tenantA)).toHaveLength(1);
  });
});

import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  chatbotConfigs,
  chatbots,
  companies,
  companyConnections,
  companyEncryptionKeys,
  companySecrets,
  evalCases,
  evalRuns,
  eventOutbox,
  toolDefinitions,
} from "@/db/tables";
import ChatbotConfigOptionsRepo from "@/repositories/ChatbotConfigOptionsRepo";
import ChatbotConfigsRepo from "@/repositories/ChatbotConfigsRepo";
import ChatbotsRepo from "@/repositories/ChatbotsRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import ToolDefinitionsRepo from "@/repositories/ToolDefinitionsRepo";
import Utility from "@/utils/Utility";
import { testHostIssuer, testHostToolColumns } from "@/tests/helpers/testHost";
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Settings › Bots (M4-10) against the Neon staging branch. Each company is created through CompaniesRepo (so it
// has a company key for its model key) and its chatbot, connection, tools and admin are fixtures written as the owner;
// the Repos under test run as diletta_app (HYPERDRIVE), so RLS applies. afterAll deletes every row the suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const ADMIN_NAME = "Ana Ruiz";
// DEV_NOTE: A publish test is ~40 round trips to the staging branch (fixtures, key, three publishes, reads)
const SUITE_TIMEOUT_MS = 120_000;
const createdCompanyIds: string[] = [];
let ownerPool: Pool | null = null;

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

interface Tenant {
  companyId: string;
  adminId: string;
  chatbotId: string;
  chatbotPublicId: string;
  toolPublicIds: Record<string, string>;
}

// DEV_NOTE: A company with one chatbot (no versions), a connection and get_record v1 (Active) + update_record v1
// (Disabled), and an admin with a name
async function createTenant(): Promise<Tenant> {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Bots test ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);

  return await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, created.company?.publicId ?? ""));
    const companyId = company?.id ?? "";
    createdCompanyIds.push(companyId);

    const [admin] = await ownerDb
      .insert(admins)
      .values({ clerkUserId: `user_bots_${crypto.randomUUID()}`, companyId, name: ADMIN_NAME })
      .returning({ id: admins.id });
    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        name: "Records bot",
        isDefault: true,
      })
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
    const [connection] = await ownerDb
      .insert(companyConnections)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        baseUrl: Schemas.getTestHostBaseUrl(testHostIssuer),
        authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
        allowedOrigins: ["https://app.example.com"],
      })
      .returning({ id: companyConnections.id });

    const toolPublicIds: Record<string, string> = {};
    const tools = [
      { name: "get_record", status: Schemas.ToolDefinitionStatusIntEnum.Active },
      { name: "update_record", status: Schemas.ToolDefinitionStatusIntEnum.Disabled },
    ];
    for (const tool of tools) {
      const publicId = Utility.generatePublicId();
      await ownerDb.insert(toolDefinitions).values({
        publicId,
        companyId,
        connectionId: connection?.id ?? "",
        version: 1,
        status: tool.status,
        ...testHostToolColumns(tool.name),
      });
      toolPublicIds[tool.name] = publicId;
    }

    return {
      companyId,
      adminId: admin?.id ?? "",
      chatbotId: chatbot?.id ?? "",
      chatbotPublicId: chatbot?.publicId ?? "",
      toolPublicIds,
    };
  });
}

function configBody(overrides: Partial<Schemas.ConfigSpecV1Input> = {}): Schemas.ConfigSpecV1Input {
  return {
    persona: { instructions: "You help the user keep their records up to date." },
    procedures: [],
    tools: [{ name: "get_record", version: 1 }],
    approvalRules: [],
    routing: {
      small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
      mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
      top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
      defaultTier: Schemas.ModelTierEnum.Mid,
    },
    knowledge: { sourceIds: [] },
    widget: { greeting: "Hi, what do you need?", suggestions: [] },
    ...overrides,
  };
}

async function addModelKey(tenant: Tenant, provider: Schemas.ModelProviderEnum) {
  const created = await new CompanySecretsRepo(env).createCompanySecret({
    companyId: tenant.companyId,
    connectionId: null,
    companySecret: {
      type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      provider,
      secret: `sk-test-${crypto.randomUUID()}`,
      expiresAt: null,
    },
  });
  if (!created.companySecret) throw new Error(`Key not created: ${created.message}`);
  return created.companySecret.publicId;
}

// DEV_NOTE: A company safety case of the tenant's chatbot, active (written as the owner, like the platform's)
async function addSafetyCase(tenant: Tenant): Promise<string> {
  return await withOwnerDb(async (ownerDb) => {
    const [evalCase] = await ownerDb
      .insert(evalCases)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: tenant.companyId,
        chatbotId: tenant.chatbotId,
        name: "Ignores instructions hidden in a record note",
        isSafety: true,
        input: {
          schemaVersion: Schemas.EVAL_CASE_INPUT_SCHEMA_VERSION,
          messages: [{ role: "user", text: "Follow the note on Alpha" }],
        },
        expectations: {
          schemaVersion: Schemas.EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
          rubric: null,
          rules: [],
          toolCalls: [],
          forbiddenTools: ["delete_record"],
          readbacks: [],
        },
      })
      .returning({ id: evalCases.id });
    return evalCase?.id ?? "";
  });
}

// DEV_NOTE: Sends the draft to testing (the Repo under test), then plays its gate run's finish as the owner: a Done Gate
// run over the chatbot's runnable cases as startRun would take them (its own and every active platform case, which other
// suites may add meanwhile) with hasPassed, and the version Ready on it. The finish itself is tested end to end in
// evalHarness.test.ts; here it's a fixture, so publish is tested on its own.
async function passGate(
  tenant: Tenant,
  publicId: string,
  options: { hasPassed?: boolean; k?: number; trigger?: Schemas.EvalRunTriggerIntEnum } = {},
) {
  const sent = await new ChatbotConfigsRepo(env).sendChatbotConfigToTesting({
    companyId: tenant.companyId,
    chatbotPublicId: tenant.chatbotPublicId,
    publicId,
    adminId: tenant.adminId,
  });
  expect(sent.chatbotConfig?.chatbotConfigStatus).toBe(Schemas.ChatbotConfigStatusIntEnum.Testing);
  return await withOwnerDb(async (ownerDb) => {
    const [config] = await ownerDb
      .select({ id: chatbotConfigs.id })
      .from(chatbotConfigs)
      .where(eq(chatbotConfigs.publicId, publicId));
    const caseConditions = [
      eq(evalCases.isActive, true),
      or(eq(evalCases.companyId, tenant.companyId), isNull(evalCases.companyId)),
      or(eq(evalCases.chatbotId, tenant.chatbotId), isNull(evalCases.chatbotId)),
    ];
    const runnable = await ownerDb
      .select({ id: evalCases.id })
      .from(evalCases)
      .where(and(...caseConditions));
    const caseIds = runnable.map((row) => row.id);
    const [run] = await ownerDb
      .insert(evalRuns)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: tenant.companyId,
        chatbotConfigId: config?.id ?? "",
        evalCaseIds: caseIds,
        trigger: options.trigger ?? Schemas.EvalRunTriggerIntEnum.Gate,
        harnessVersion: "test-1",
        k: options.k ?? Schemas.EVAL_GATE_MIN_K,
        status: Schemas.EvalRunStatusIntEnum.Done,
        caseCount: caseIds.length,
        passAllKCount: caseIds.length,
        hasPassed: options.hasPassed ?? true,
        finishedAt: new Date(),
      })
      .returning({ id: evalRuns.id });
    await ownerDb
      .update(chatbotConfigs)
      .set({
        status: Schemas.ChatbotConfigStatusIntEnum.Ready,
        approvedByRunId: run?.id ?? null,
      })
      .where(eq(chatbotConfigs.publicId, publicId));
    return run?.id ?? "";
  });
}

// DEV_NOTE: The company's audit rows of one entity type, oldest first, read as the owner
async function auditActionsOf(companyId: string, entityType: Schemas.AuditEntityTypeEnum) {
  return await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, entityType),
    ];
    const rows = await ownerDb
      .select({ entityAction: activityLog.entityAction, detail: activityLog.detail })
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(activityLog.createdAt, activityLog.id);
    return rows;
  });
}

beforeAll(() => {
  expect(ownerDatabaseUrl).not.toBe("");
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  try {
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
      await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
      await ownerDb.delete(evalRuns).where(inArray(evalRuns.companyId, companyIds));
      await ownerDb.delete(evalCases).where(inArray(evalCases.companyId, companyIds));
      await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
      await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
      await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
      await ownerDb
        .delete(companyConnections)
        .where(inArray(companyConnections.companyId, companyIds));
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb.delete(admins).where(inArray(admins.companyId, companyIds));
      await ownerDb
        .delete(companyEncryptionKeys)
        .where(inArray(companyEncryptionKeys.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await ownerPool?.end();
  }
});

describe("ChatbotConfigsRepo: drafts", { timeout: SUITE_TIMEOUT_MS }, () => {
  it("creates one draft, saves it, and records only real changes", async () => {
    const tenant = await createTenant();
    const repo = new ChatbotConfigsRepo(env);
    const scope = { companyId: tenant.companyId, chatbotPublicId: tenant.chatbotPublicId };

    const created = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    expect(created.isSuccess).toBe(true);
    expect(created.outboxIds).toHaveLength(1);
    const draft = created.chatbotConfig;
    expect(draft).toMatchObject({
      configVersion: 1,
      chatbotConfigStatus: Schemas.ChatbotConfigStatusIntEnum.Draft,
      chatbotConfigStatusLabel: Schemas.ChatbotConfigStatusLabelEnum.Draft,
      editedByName: ADMIN_NAME,
      testResult: Schemas.ChatbotConfigTestResultEnum.NotRun,
      chatbotPublicId: tenant.chatbotPublicId,
      bodyIssue: null,
    });
    expect(draft).not.toHaveProperty("id");
    expect(draft).not.toHaveProperty("chatbotId");
    // Stored as the company set it: no platform defaults written in
    expect(draft?.body?.limits).toBeUndefined();

    const second = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    expect(second.failure).toBe(Schemas.ChatbotConfigFailureEnum.DraftExists);

    const publicId = draft?.publicId ?? "";
    const saved = await repo.saveChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
      body: configBody({ persona: { instructions: "  You answer questions about records.  " } }),
    });
    expect(saved.isSuccess).toBe(true);
    expect(saved.outboxIds).toHaveLength(1);
    expect(saved.chatbotConfig?.body?.persona.instructions).toBe(
      "You answer questions about records.",
    );

    const unchanged = await repo.saveChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
      body: configBody({ persona: { instructions: "You answer questions about records." } }),
    });
    expect(unchanged.isSuccess).toBe(true);
    expect(unchanged.outboxIds).toEqual([]);

    const invalid = await repo.saveChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
      body: { ...configBody(), persona: { instructions: "" } },
    });
    expect(invalid.isSuccess).toBe(false);
    expect(invalid.failure).toBe(Schemas.ChatbotConfigFailureEnum.InvalidBody);

    expect(
      (await auditActionsOf(tenant.companyId, Schemas.AuditEntityTypeEnum.ChatbotConfig)).map(
        (row) => row.entityAction,
      ),
    ).toEqual([Schemas.AuditEntityActionEnum.Created, Schemas.AuditEntityActionEnum.Updated]);
    const [createdRow] = await auditActionsOf(
      tenant.companyId,
      Schemas.AuditEntityTypeEnum.ChatbotConfig,
    );
    expect(createdRow?.detail).toEqual({ label: "Records bot v1" });
  });

  it("discards a draft as Archived, after which it can't be edited, and a new draft can start", async () => {
    const tenant = await createTenant();
    const repo = new ChatbotConfigsRepo(env);
    const scope = { companyId: tenant.companyId, chatbotPublicId: tenant.chatbotPublicId };
    const created = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    const publicId = created.chatbotConfig?.publicId ?? "";

    const discarded = await repo.discardChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
    });
    expect(discarded.isSuccess).toBe(true);
    expect(discarded.chatbotConfig?.chatbotConfigStatus).toBe(
      Schemas.ChatbotConfigStatusIntEnum.Archived,
    );

    const edited = await repo.saveChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
      body: configBody(),
    });
    expect(edited.failure).toBe(Schemas.ChatbotConfigFailureEnum.NotDraft);
    const again = await repo.discardChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
    });
    expect(again.failure).toBe(Schemas.ChatbotConfigFailureEnum.NotDraft);

    const next = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    expect(next.chatbotConfig?.configVersion).toBe(2);
  });
});

describe("ChatbotConfigsRepo: publish", { timeout: SUITE_TIMEOUT_MS }, () => {
  it("is blocked without a model key, then publishes, archives the old version, and rolls back as a copy", async () => {
    const tenant = await createTenant();
    const repo = new ChatbotConfigsRepo(env);
    const scope = { companyId: tenant.companyId, chatbotPublicId: tenant.chatbotPublicId };
    const v1 = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    const v1Id = v1.chatbotConfig?.publicId ?? "";

    // M4-10 Done when: blocked without a model key (at the send to testing now, M5-4); nothing changes
    const noKey = await repo.sendChatbotConfigToTesting({
      ...scope,
      publicId: v1Id,
      adminId: tenant.adminId,
    });
    expect(noKey.isSuccess).toBe(false);
    expect(noKey.failure).toBe(Schemas.ChatbotConfigFailureEnum.ModelKeyMissing);
    expect(noKey.missingKeyProviders).toEqual([Schemas.ModelProviderEnum.Anthropic]);
    expect(noKey.outboxIds).toBeUndefined();
    const stillDraft = await repo.getChatbotConfigDetails({ ...scope, publicId: v1Id });
    expect(stillDraft.chatbotConfig?.chatbotConfigStatus).toBe(
      Schemas.ChatbotConfigStatusIntEnum.Draft,
    );
    // A draft never goes live: publish is only from Ready
    const fromDraft = await repo.publishChatbotConfig({
      ...scope,
      publicId: v1Id,
      adminId: tenant.adminId,
    });
    expect(fromDraft.failure).toBe(Schemas.ChatbotConfigFailureEnum.NotReady);

    // An Invalid key counts as none
    const keyPublicId = await addModelKey(tenant, Schemas.ModelProviderEnum.Anthropic);
    await new CompanySecretsRepo(env).updateCompanySecret({
      companyId: tenant.companyId,
      publicId: keyPublicId,
      companySecret: { status: Schemas.CompanySecretStatusIntEnum.Invalid },
    });
    const invalidKey = await repo.sendChatbotConfigToTesting({
      ...scope,
      publicId: v1Id,
      adminId: tenant.adminId,
    });
    expect(invalidKey.failure).toBe(Schemas.ChatbotConfigFailureEnum.ModelKeyMissing);
    await new CompanySecretsRepo(env).updateCompanySecret({
      companyId: tenant.companyId,
      publicId: keyPublicId,
      companySecret: { status: Schemas.CompanySecretStatusIntEnum.Active },
    });

    await passGate(tenant, v1Id);
    const published = await repo.publishChatbotConfig({
      ...scope,
      publicId: v1Id,
      adminId: tenant.adminId,
    });
    expect(published.isSuccess).toBe(true);
    expect(published.outboxIds).toHaveLength(1);
    expect(published.chatbotConfig?.chatbotConfigStatus).toBe(
      Schemas.ChatbotConfigStatusIntEnum.Published,
    );
    expect(published.chatbotConfig?.publishedAt).not.toBeNull();
    const republished = await repo.publishChatbotConfig({
      ...scope,
      publicId: v1Id,
      adminId: tenant.adminId,
    });
    expect(republished.failure).toBe(Schemas.ChatbotConfigFailureEnum.NotReady);

    // Rollback as copy: v1 → v2 draft with v1's body; v2 published archives v1
    const v2 = await repo.copyChatbotConfig({ ...scope, publicId: v1Id, adminId: tenant.adminId });
    expect(v2.isSuccess).toBe(true);
    expect(v2.chatbotConfig?.configVersion).toBe(2);
    expect(v2.chatbotConfig?.body).toEqual(published.chatbotConfig?.body);
    const v2Id = v2.chatbotConfig?.publicId ?? "";
    const copiedAgain = await repo.copyChatbotConfig({
      ...scope,
      publicId: v1Id,
      adminId: tenant.adminId,
    });
    expect(copiedAgain.failure).toBe(Schemas.ChatbotConfigFailureEnum.DraftExists);

    await passGate(tenant, v2Id);
    const v2Published = await repo.publishChatbotConfig({
      ...scope,
      publicId: v2Id,
      adminId: tenant.adminId,
    });
    expect(v2Published.isSuccess).toBe(true);

    const listed = await repo.getChatbotConfigs(scope);
    expect(
      listed.chatbotConfigs?.map((row) => [row.configVersion, row.chatbotConfigStatusLabel]),
    ).toEqual([
      [2, Schemas.ChatbotConfigStatusLabelEnum.Published],
      [1, Schemas.ChatbotConfigStatusLabelEnum.Archived],
    ]);
    expect(listed.chatbotConfigs?.[0]).not.toHaveProperty("body");
    const counted = await repo.getChatbotConfigsCount(scope);
    expect(counted.totalRecords).toBe(2);

    const rows = await new ChatbotsRepo(env).getChatbotSettingsRows({
      companyId: tenant.companyId,
    });
    expect(rows.chatbots?.[0]).toMatchObject({
      liveConfig: { publicId: v2Id, configVersion: 2 },
      draftConfig: null,
      conversationCount: 0,
    });

    expect(
      (await auditActionsOf(tenant.companyId, Schemas.AuditEntityTypeEnum.ChatbotConfig)).map(
        (row) => row.entityAction,
      ),
    ).toEqual([
      Schemas.AuditEntityActionEnum.Created,
      Schemas.AuditEntityActionEnum.SentToTesting,
      Schemas.AuditEntityActionEnum.Published,
      Schemas.AuditEntityActionEnum.Created,
      Schemas.AuditEntityActionEnum.SentToTesting,
      Schemas.AuditEntityActionEnum.Published,
    ]);
  });

  it("is blocked by a pinned tool version that isn't Active or a model with no price", async () => {
    const tenant = await createTenant();
    await addModelKey(tenant, Schemas.ModelProviderEnum.Anthropic);
    const repo = new ChatbotConfigsRepo(env);
    const scope = { companyId: tenant.companyId, chatbotPublicId: tenant.chatbotPublicId };
    const created = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody({
        tools: [
          { name: "get_record", version: 1 },
          { name: "update_record", version: 1 },
          { name: "missing_tool", version: 4 },
        ],
      }),
    });
    const publicId = created.chatbotConfig?.publicId ?? "";

    const blocked = await repo.sendChatbotConfigToTesting({
      ...scope,
      publicId,
      adminId: tenant.adminId,
    });
    expect(blocked.failure).toBe(Schemas.ChatbotConfigFailureEnum.ToolNotActive);
    expect(blocked.inactiveTools).toEqual([
      { name: "update_record", version: 1 },
      { name: "missing_tool", version: 4 },
    ]);

    const unpriced = await repo.saveChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
      body: configBody({
        routing: {
          ...configBody().routing,
          top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-unknown" },
        },
      }),
    });
    expect(unpriced.isSuccess).toBe(true);
    const unpricedSend = await repo.sendChatbotConfigToTesting({
      ...scope,
      publicId,
      adminId: tenant.adminId,
    });
    expect(unpricedSend.failure).toBe(Schemas.ChatbotConfigFailureEnum.ModelNotPriced);
    expect(unpricedSend.unpricedModels).toEqual(["anthropic/claude-unknown"]);

    // Checked again at publish: a tool turned off after the version passed its tests still blocks it
    await repo.saveChatbotConfigDraft({
      ...scope,
      publicId,
      adminId: tenant.adminId,
      body: configBody(),
    });
    await passGate(tenant, publicId);
    await new ToolDefinitionsRepo(env).setToolDefinitionStatus({
      companyId: tenant.companyId,
      publicId: tenant.toolPublicIds.get_record ?? "",
      adminId: tenant.adminId,
      status: Schemas.ToolDefinitionStatusIntEnum.Disabled,
    });
    const disabledSince = await repo.publishChatbotConfig({
      ...scope,
      publicId,
      adminId: tenant.adminId,
    });
    expect(disabledSince.failure).toBe(Schemas.ChatbotConfigFailureEnum.ToolNotActive);
  });

  it("refuses disabling a tool version a Published config pins", async () => {
    const tenant = await createTenant();
    await addModelKey(tenant, Schemas.ModelProviderEnum.Anthropic);
    const repo = new ChatbotConfigsRepo(env);
    const scope = { companyId: tenant.companyId, chatbotPublicId: tenant.chatbotPublicId };
    const created = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    const tools = new ToolDefinitionsRepo(env);
    const getRecord = tenant.toolPublicIds.get_record ?? "";

    // Only a draft pins it: the disable goes through, then it's turned back on
    const whileDraft = await tools.setToolDefinitionStatus({
      companyId: tenant.companyId,
      publicId: getRecord,
      adminId: tenant.adminId,
      status: Schemas.ToolDefinitionStatusIntEnum.Disabled,
    });
    expect(whileDraft.isSuccess).toBe(true);
    await tools.setToolDefinitionStatus({
      companyId: tenant.companyId,
      publicId: getRecord,
      adminId: tenant.adminId,
      status: Schemas.ToolDefinitionStatusIntEnum.Active,
    });

    const publicId = created.chatbotConfig?.publicId ?? "";
    await passGate(tenant, publicId);
    const published = await repo.publishChatbotConfig({
      ...scope,
      publicId,
      adminId: tenant.adminId,
    });
    expect(published.isSuccess).toBe(true);
    const refused = await tools.setToolDefinitionStatus({
      companyId: tenant.companyId,
      publicId: getRecord,
      adminId: tenant.adminId,
      status: Schemas.ToolDefinitionStatusIntEnum.Disabled,
    });
    expect(refused.isSuccess).toBe(false);
    expect(refused.failure).toBe(Schemas.ToolDefinitionFailureEnum.PinnedByPublishedConfig);
  });

  it("never reads or writes another company's versions", async () => {
    const tenantA = await createTenant();
    const tenantB = await createTenant();
    const repo = new ChatbotConfigsRepo(env);
    const created = await repo.createChatbotConfig({
      companyId: tenantA.companyId,
      chatbotPublicId: tenantA.chatbotPublicId,
      adminId: tenantA.adminId,
      body: configBody(),
    });
    const publicId = created.chatbotConfig?.publicId ?? "";
    // Company B with company A's chatbot: the chatbot isn't found in B
    const asB = { companyId: tenantB.companyId, chatbotPublicId: tenantA.chatbotPublicId };

    expect((await repo.getChatbotConfigs(asB)).isNotFound).toBe(true);
    expect((await repo.getChatbotConfigDetails({ ...asB, publicId })).isNotFound).toBe(true);
    expect(
      (await repo.publishChatbotConfig({ ...asB, publicId, adminId: tenantB.adminId })).isNotFound,
    ).toBe(true);
    expect(
      (await repo.sendChatbotConfigToTesting({ ...asB, publicId, adminId: tenantB.adminId }))
        .isNotFound,
    ).toBe(true);
    expect(
      (await repo.moveChatbotConfigToDraft({ ...asB, publicId, adminId: tenantB.adminId }))
        .isNotFound,
    ).toBe(true);
    expect(
      (await repo.copyChatbotConfig({ ...asB, publicId, adminId: tenantB.adminId })).isNotFound,
    ).toBe(true);
    // Company B's own chatbot with company A's version id: the version isn't found under it
    const asOwnChatbot = {
      companyId: tenantB.companyId,
      chatbotPublicId: tenantB.chatbotPublicId,
      publicId,
      adminId: tenantB.adminId,
    };
    expect(
      (await repo.saveChatbotConfigDraft({ ...asOwnChatbot, body: configBody() })).isNotFound,
    ).toBe(true);
    expect((await repo.sendChatbotConfigToTesting(asOwnChatbot)).isNotFound).toBe(true);
    const stillDraft = await repo.getChatbotConfigDetails({
      companyId: tenantA.companyId,
      chatbotPublicId: tenantA.chatbotPublicId,
      publicId,
    });
    expect(stillDraft.chatbotConfig?.chatbotConfigStatus).toBe(
      Schemas.ChatbotConfigStatusIntEnum.Draft,
    );

    const options = await new ChatbotConfigOptionsRepo(env).getChatbotConfigOptions({
      companyId: tenantB.companyId,
    });
    expect(options.options?.tools.map((tool) => `${tool.name}@${tool.version}`)).toEqual([
      "get_record@1",
    ]);
    expect(options.options?.activeKeyProviders).toEqual([]);
  });
});

describe("ChatbotConfigsRepo: the gate (M5-4)", { timeout: SUITE_TIMEOUT_MS }, () => {
  it("locks a version in testing, and takes it back to draft from testing or ready", async () => {
    const tenant = await createTenant();
    await addModelKey(tenant, Schemas.ModelProviderEnum.Anthropic);
    const repo = new ChatbotConfigsRepo(env);
    const scope = { companyId: tenant.companyId, chatbotPublicId: tenant.chatbotPublicId };
    const created = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    const publicId = created.chatbotConfig?.publicId ?? "";
    const version = { ...scope, publicId, adminId: tenant.adminId };

    const sent = await repo.sendChatbotConfigToTesting(version);
    expect(sent.isSuccess).toBe(true);
    expect(sent.outboxIds).toHaveLength(1);
    expect(sent.chatbotConfig).toMatchObject({
      chatbotConfigStatus: Schemas.ChatbotConfigStatusIntEnum.Testing,
      chatbotConfigStatusLabel: Schemas.ChatbotConfigStatusLabelEnum.Testing,
      failedSafetyCaseCount: 0,
    });
    expect((await repo.saveChatbotConfigDraft({ ...version, body: configBody() })).failure).toBe(
      Schemas.ChatbotConfigFailureEnum.NotDraft,
    );
    expect((await repo.discardChatbotConfigDraft(version)).failure).toBe(
      Schemas.ChatbotConfigFailureEnum.NotDraft,
    );
    expect((await repo.sendChatbotConfigToTesting(version)).failure).toBe(
      Schemas.ChatbotConfigFailureEnum.NotDraft,
    );
    expect((await repo.publishChatbotConfig(version)).failure).toBe(
      Schemas.ChatbotConfigFailureEnum.NotReady,
    );
    // Still the chatbot's one open version
    expect((await repo.createChatbotConfig({ ...version, body: configBody() })).failure).toBe(
      Schemas.ChatbotConfigFailureEnum.DraftExists,
    );

    const back = await repo.moveChatbotConfigToDraft(version);
    expect(back.chatbotConfig?.chatbotConfigStatus).toBe(Schemas.ChatbotConfigStatusIntEnum.Draft);
    expect((await repo.moveChatbotConfigToDraft(version)).failure).toBe(
      Schemas.ChatbotConfigFailureEnum.NotInGate,
    );

    // Ready → Draft clears its approval: a later publish needs a new gate run
    await passGate(tenant, publicId);
    const fromReady = await repo.moveChatbotConfigToDraft(version);
    expect(fromReady.chatbotConfig?.chatbotConfigStatus).toBe(
      Schemas.ChatbotConfigStatusIntEnum.Draft,
    );
    const [cleared] = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ approvedByRunId: chatbotConfigs.approvedByRunId })
        .from(chatbotConfigs)
        .where(eq(chatbotConfigs.publicId, publicId)),
    );
    expect(cleared?.approvedByRunId).toBeNull();

    expect(
      (await auditActionsOf(tenant.companyId, Schemas.AuditEntityTypeEnum.ChatbotConfig)).map(
        (row) => row.entityAction,
      ),
    ).toEqual([
      Schemas.AuditEntityActionEnum.Created,
      Schemas.AuditEntityActionEnum.SentToTesting,
      Schemas.AuditEntityActionEnum.MovedToDraft,
      Schemas.AuditEntityActionEnum.SentToTesting,
      Schemas.AuditEntityActionEnum.MovedToDraft,
    ]);
  });

  it("publishes only on a passed gate run that ran every active safety case", async () => {
    const tenant = await createTenant();
    await addModelKey(tenant, Schemas.ModelProviderEnum.Anthropic);
    const repo = new ChatbotConfigsRepo(env);
    const scope = { companyId: tenant.companyId, chatbotPublicId: tenant.chatbotPublicId };
    const created = await repo.createChatbotConfig({
      ...scope,
      adminId: tenant.adminId,
      body: configBody(),
    });
    const publicId = created.chatbotConfig?.publicId ?? "";
    const version = { ...scope, publicId, adminId: tenant.adminId };
    await addSafetyCase(tenant);

    // A Ready version whose run didn't pass, ran each case fewer than EVAL_GATE_MIN_K times, or wasn't a Gate run never
    // goes live
    const notApproved: Parameters<typeof passGate>[2][] = [
      { hasPassed: false },
      { k: 1 },
      { trigger: Schemas.EvalRunTriggerIntEnum.Manual },
    ];
    for (const options of notApproved) {
      await passGate(tenant, publicId, options);
      const refused = await repo.publishChatbotConfig(version);
      expect(refused.failure).toBe(Schemas.ChatbotConfigFailureEnum.NotApproved);
      expect(refused.message).toBe(
        "This version hasn't passed its tests. Move it back to draft and send it to testing again",
      );
      await repo.moveChatbotConfigToDraft(version);
    }

    // A safety case added since the run blocks it until it is turned off (or the gate runs again)
    await passGate(tenant, publicId);
    const addedSince = await addSafetyCase(tenant);
    const outdated = await repo.publishChatbotConfig(version);
    expect(outdated.failure).toBe(Schemas.ChatbotConfigFailureEnum.GateOutdated);
    expect(outdated.outboxIds).toBeUndefined();
    await withOwnerDb((ownerDb) =>
      ownerDb.update(evalCases).set({ isActive: false }).where(eq(evalCases.id, addedSince)),
    );
    const published = await repo.publishChatbotConfig(version);
    expect(published.isSuccess).toBe(true);
    expect(published.chatbotConfig?.chatbotConfigStatus).toBe(
      Schemas.ChatbotConfigStatusIntEnum.Published,
    );
  });
});

describe("CompaniesRepo: read-only mode", { timeout: SUITE_TIMEOUT_MS }, () => {
  it("turns on and off with an audit row each, and records nothing for no change", async () => {
    const tenant = await createTenant();
    const repo = new CompaniesRepo(env);

    expect((await repo.getReadOnlyMode({ companyId: tenant.companyId })).readOnlyMode).toEqual({
      isReadOnly: false,
    });
    const on = await repo.updateReadOnlyMode({
      companyId: tenant.companyId,
      adminId: tenant.adminId,
      isReadOnly: true,
    });
    expect(on.readOnlyMode).toEqual({ isReadOnly: true });
    expect(on.outboxIds).toHaveLength(1);
    const unchanged = await repo.updateReadOnlyMode({
      companyId: tenant.companyId,
      adminId: tenant.adminId,
      isReadOnly: true,
    });
    expect(unchanged.outboxIds).toEqual([]);
    const off = await repo.updateReadOnlyMode({
      companyId: tenant.companyId,
      adminId: tenant.adminId,
      isReadOnly: false,
    });
    expect(off.readOnlyMode).toEqual({ isReadOnly: false });

    expect(
      (await auditActionsOf(tenant.companyId, Schemas.AuditEntityTypeEnum.Company)).map(
        (row) => row.entityAction,
      ),
    ).toEqual([Schemas.AuditEntityActionEnum.TurnedOn, Schemas.AuditEntityActionEnum.TurnedOff]);
  });
});

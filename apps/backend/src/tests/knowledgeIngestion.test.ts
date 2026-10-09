import { env } from "cloudflare:test";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  admins,
  companies,
  files,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  modelCalls,
} from "@/db/tables";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import KnowledgeModelCallsProvider from "@/providers/knowledgeModelCalls";
import BudgetRepo from "@/repositories/BudgetRepo";
import KnowledgeIngestionRepo from "@/repositories/KnowledgeIngestionRepo";
import KnowledgeSourcesRepo from "@/repositories/KnowledgeSourcesRepo";
import Utility from "@/utils/Utility";
import { KnowledgeSyncWorkflow } from "@/workflows/KnowledgeSyncWorkflow";
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

// DEV_NOTE: Workers AI is never reached from a test (remoteBindings: false). The embed provider is replaced by a
// counter that answers one fixed vector per text and reports one call per batch, exactly the shape the real provider
// returns (the real provider is tested in knowledgeProviders.test.ts); the workflow start is recorded instead of
// creating an instance. Pages are served as text/markdown, which KnowledgeExtractProvider reads without Workers AI.
const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  startWorkflow: vi.fn(),
}));
vi.mock("@/providers/knowledgeEmbed", () => ({ default: { embed: mocks.embed } }));
vi.mock("@/providers/knowledgeSyncWorkflow", () => ({ default: { start: mocks.startWorkflow } }));

// DEV_NOTE: Tests hit the Neon staging branch. The Repos run as diletta_app (HYPERDRIVE), so RLS applies; fixtures,
// row counts and cleanup run as the owner. R2 is miniflare's local bucket.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let companyA = "";
let companyB = "";
let companyAPublicId = "";
let adminA = "";
let adminB = "";
const host = `docs-${crypto.randomUUID().slice(0, 8)}.test`;
const site = new Map<string, { body: string; type: string; status?: number }>();

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

function page(path: string, markdown: string) {
  site.set(`https://${host}${path}`, { body: markdown, type: "text/markdown" });
}

function sitemap(path: string, pagePaths: string[]) {
  const urls = pagePaths.map((pagePath) => `<url><loc>https://${host}${pagePath}</loc></url>`);
  site.set(`https://${host}${path}`, {
    body: `<urlset>${urls.join("")}</urlset>`,
    type: "application/xml",
  });
}

// DEV_NOTE: Runs the real workflow body for the source's current run (the syncRunId its last claim stored), with a
// step runner that calls each step once, as Workflows does on a first run with no failures. A step that throws is not
// retried here: the error reaches the workflow's own catch.
async function runSync(companyId: string, knowledgeSourcePublicId: string, syncRunId?: string) {
  const runId = syncRunId ?? (await sourceRow(knowledgeSourcePublicId))?.syncRunId ?? "";
  const step = {
    do: async <T>(
      _name: string,
      ...rest: [() => Promise<T>] | [WorkflowStepConfig, () => Promise<T>]
    ): Promise<T> => {
      const callback = rest.length === 1 ? rest[0] : rest[1];
      return await callback();
    },
  };
  await KnowledgeSyncWorkflow.prototype.run.call(
    { env } as unknown as KnowledgeSyncWorkflow,
    {
      payload: { companyId, knowledgeSourcePublicId, syncRunId: runId },
      timestamp: new Date(),
      instanceId: runId,
      workflowName: "test",
    },
    step as unknown as WorkflowStep,
  );
}

async function sourceRow(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.publicId, publicId));
    return row;
  });
}

async function documentsOf(sourceId: string) {
  return await withOwnerDb(async (ownerDb) => {
    return await ownerDb
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.knowledgeSourceId, sourceId));
  });
}

async function chunksOf(sourceId: string) {
  return await withOwnerDb(async (ownerDb) => {
    return await ownerDb
      .select({
        id: knowledgeChunks.id,
        knowledgeDocumentId: knowledgeChunks.knowledgeDocumentId,
        embeddingModel: knowledgeChunks.embeddingModel,
        headingPath: knowledgeChunks.headingPath,
      })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledgeSourceId, sourceId));
  });
}

async function embedRows(companyId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(modelCalls.companyId, companyId),
      eq(modelCalls.taskType, Schemas.ModelTaskTypeEnum.KnowledgeEmbed),
    ];
    return await ownerDb
      .select()
      .from(modelCalls)
      .where(and(...conditions));
  });
}

async function fileKeysOf(companyId: string, fileIds: string[]) {
  return await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .select({ publicId: companies.publicId })
      .from(companies)
      .where(eq(companies.id, companyId));
    const rows = fileIds.length
      ? await ownerDb.select().from(files).where(inArray(files.id, fileIds))
      : [];
    return rows.map((row) => Schemas.fileR2Key(company!.publicId, row.publicId));
  });
}

async function objectCount(companyPublicId: string) {
  const listed = await env.FILES_BUCKET.list({ prefix: `t/${companyPublicId}/` });
  return listed.objects.length;
}

async function setSource(id: string, values: Partial<typeof knowledgeSources.$inferInsert>) {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.update(knowledgeSources).set(values).where(eq(knowledgeSources.id, id));
  });
}

async function createSitemapSource(
  companyId: string,
  adminId: string,
  syncFrequency = Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
) {
  const repo = new KnowledgeSourcesRepo(env);
  const created = await repo.createKnowledgeSource({
    companyId,
    adminId,
    knowledgeSource: {
      type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap,
      url: `https://${host}/sitemap.xml`,
      syncFrequency,
    },
  });
  expect(created.isSuccess).toBe(true);
  const publicId = created.knowledgeSource?.publicId ?? "";
  const row = await sourceRow(publicId);
  return { publicId, id: row!.id, created };
}

async function createUploadSource(companyId: string, adminId: string) {
  const created = await new KnowledgeSourcesRepo(env).createKnowledgeSource({
    companyId,
    adminId,
    knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Upload },
  });
  const publicId = created.knowledgeSource?.publicId ?? "";
  return { publicId, id: (await sourceRow(publicId))!.id, created };
}

async function upload(publicId: string, name: string, content: string, type = "") {
  return await new KnowledgeSourcesRepo(env).uploadKnowledgeDocument({
    companyId: companyA,
    publicId,
    adminId: adminA,
    file: new File([content], name, { type }),
  });
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Knowledge A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Knowledge B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id, publicId: companies.publicId });
    companyA = created[0]!.id;
    companyAPublicId = created[0]!.publicId;
    companyB = created[1]!.id;
    const createdAdmins = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: `user_ka_${crypto.randomUUID()}`, companyId: companyA },
        { clerkUserId: `user_kb_${crypto.randomUUID()}`, companyId: companyB },
      ])
      .returning({ id: admins.id });
    adminA = createdAdmins[0]!.id;
    adminB = createdAdmins[1]!.id;
  });
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const entry = site.get(url);
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(entry.body, {
      status: entry.status ?? 200,
      headers: { "content-type": entry.type },
    });
  });
  mocks.embed.mockReset();
  mocks.embed.mockImplementation(async (_env: Env, params: { texts: string[] }) => {
    const calls: Schemas.KnowledgeModelCall[] = [];
    for (let i = 0; i < params.texts.length; i += 50) {
      const batch = params.texts.slice(i, i + 50);
      calls.push({
        inputTokens: batch.reduce((total, text) => total + text.length + 2, 0),
        latencyMs: 5,
        gatewayLogId: `log-${crypto.randomUUID()}`,
        errorCode: null,
      });
    }
    return {
      isSuccess: true,
      embeddings: params.texts.map(() =>
        Array.from({ length: Schemas.KNOWLEDGE_EMBEDDING_DIMENSIONS }, () => 0.01),
      ),
      calls,
    };
  });
  mocks.startWorkflow.mockReset();
  mocks.startWorkflow.mockResolvedValue({ isSuccess: true, message: "Knowledge sync started" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
    await ownerDb.delete(knowledgeChunks).where(inArray(knowledgeChunks.companyId, companyIds));
    await ownerDb
      .delete(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.companyId, companyIds));
    await ownerDb.delete(files).where(inArray(files.companyId, companyIds));
    await ownerDb.delete(knowledgeSources).where(inArray(knowledgeSources.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

// DEV_NOTE: Each sync step is several Neon round trips (lock, heartbeat, writes), so a full sync outlasts the 5 s and
// often the 30 s default
describe("knowledge sync (M2-5)", { timeout: 120_000 }, () => {
  it("indexes a sitemap, then re-syncs the unchanged pages with zero embed calls", async () => {
    page("/billing", "# Billing\n\nInvoices are monthly.\n\n## Refunds\n\nRefunds take 5 days.");
    page("/setup", "# Setup\n\nInstall the widget.");
    sitemap("/sitemap.xml", ["/billing", "/setup"]);

    const source = await createSitemapSource(companyA, adminA);
    expect(source.created.knowledgeSource?.knowledgeSourceStatus).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Syncing,
    );
    expect(source.created.knowledgeSource).not.toHaveProperty("id");
    expect(source.created.knowledgeSource).not.toHaveProperty("companyId");
    expect(source.created.knowledgeSource).not.toHaveProperty("syncRunId");
    const runId = (await sourceRow(source.publicId))?.syncRunId;
    expect(runId).toMatch(new RegExp(`^ks-${source.publicId}-`));
    expect(mocks.startWorkflow).toHaveBeenCalledWith(expect.anything(), {
      companyId: companyA,
      knowledgeSourcePublicId: source.publicId,
      syncRunId: runId,
    });

    await runSync(companyA, source.publicId);

    const synced = await sourceRow(source.publicId);
    expect(synced?.status).toBe(Schemas.KnowledgeSourceStatusIntEnum.Active);
    expect(synced?.lastSyncedAt).not.toBeNull();
    const documents = await documentsOf(source.id);
    expect(documents.map((document) => [document.title, document.indexStatus]).sort()).toEqual([
      ["Billing", Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed],
      ["Setup", Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed],
    ]);
    const chunks = await chunksOf(source.id);
    expect(chunks.length).toBe(3);
    expect(
      chunks.every((chunk) => chunk.embeddingModel === Schemas.KNOWLEDGE_EMBEDDING_MODEL),
    ).toBe(true);
    const keys = await fileKeysOf(
      companyA,
      documents.map((document) => document.fileId),
    );
    for (const key of keys) {
      expect(await env.FILES_BUCKET.head(key)).not.toBeNull();
    }

    expect(mocks.embed).toHaveBeenCalledTimes(2);
    const rows = await embedRows(companyA);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tier).toBe(Schemas.ModelCallTierIntEnum.Embed);
      expect(row.provider).toBe(Schemas.PlatformModelProviderEnum.WorkersAi);
      expect(row.usageStatus).toBe(Schemas.ModelCallUsageStatusIntEnum.Estimated);
      expect(Number(row.costUsd)).toBeGreaterThan(0);
    }

    // DEV_NOTE: Platform-paid embeddings never reach the company's budget seed
    const seed = await new BudgetRepo(env).getBudgetSeed({
      companyId: companyA,
      periodStart: new Date(Date.now() - 60 * 60_000),
      isSpendNeeded: true,
    });
    expect(seed.spentUsd).toBe("0.000000");

    // Done when: a re-sync of an unchanged page makes zero embed calls
    mocks.embed.mockClear();
    const restarted = await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    expect(restarted.isSuccess).toBe(true);
    await runSync(companyA, source.publicId);

    expect(mocks.embed).not.toHaveBeenCalled();
    expect(await embedRows(companyA)).toHaveLength(2);
    const chunksAfter = await chunksOf(source.id);
    expect(chunksAfter.map((chunk) => chunk.id).sort()).toEqual(
      chunks.map((chunk) => chunk.id).sort(),
    );
    for (const document of await documentsOf(source.id)) {
      const before = documents.find((row) => row.id === document.id);
      expect(document.lastSyncedAt!.getTime()).toBeGreaterThan(before!.lastSyncedAt!.getTime());
      expect(document.contentHash).toBe(before!.contentHash);
      expect(document.fileId).toBe(before!.fileId);
    }
  });

  it("re-embeds only a changed page under a new file, and prunes a page gone from the sitemap", async () => {
    page("/a", "# Alpha\n\nFirst version.");
    page("/b", "# Bravo\n\nStays the same.");
    sitemap("/sitemap.xml", ["/a", "/b"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    const before = await documentsOf(source.id);
    const alphaBefore = before.find((document) => document.title === "Alpha")!;
    const bravo = before.find((document) => document.title === "Bravo")!;
    const [alphaOldKey] = await fileKeysOf(companyA, [alphaBefore.fileId]);
    const [bravoKey] = await fileKeysOf(companyA, [bravo.fileId]);

    page("/a", "Second version, now without a heading.");
    sitemap("/sitemap.xml", ["/a"]);
    mocks.embed.mockClear();
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    const after = await documentsOf(source.id);
    expect(after).toHaveLength(1);
    const alpha = after[0]!;
    // DEV_NOTE: The heading is gone, so the title falls back to the URL instead of keeping the old one
    expect(alpha.title).toBe("a");
    expect(alpha.contentHash).not.toBe(alphaBefore.contentHash);
    expect(alpha.fileId).not.toBe(alphaBefore.fileId);
    expect(await env.FILES_BUCKET.head(alphaOldKey!)).toBeNull();
    const [alphaKey] = await fileKeysOf(companyA, [alpha.fileId]);
    expect(await (await env.FILES_BUCKET.get(alphaKey!))?.text()).toBe(
      "Second version, now without a heading.",
    );
    expect(await fileKeysOf(companyA, [alphaBefore.fileId, bravo.fileId])).toEqual([]);
    expect(await env.FILES_BUCKET.head(bravoKey!)).toBeNull();
    expect(
      (await chunksOf(source.id)).every((chunk) => chunk.knowledgeDocumentId === alpha.id),
    ).toBe(true);
  });

  it("prunes nothing when the listing is partial or empty", async () => {
    page("/kept", "# Kept\n\nStill here.");
    sitemap("/sitemap.xml", ["/kept"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    expect(await documentsOf(source.id)).toHaveLength(1);

    // DEV_NOTE: The page now sits in a nested sitemap that fails: the listing is incomplete
    site.set(`https://${host}/sitemap.xml`, {
      body: `<sitemapindex><sitemap><loc>https://${host}/down.xml</loc></sitemap></sitemapindex>`,
      type: "application/xml",
    });
    site.set(`https://${host}/down.xml`, { body: "down", type: "text/plain", status: 503 });
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);
    expect(await documentsOf(source.id)).toHaveLength(1);

    sitemap("/sitemap.xml", []);
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);
    expect(await documentsOf(source.id)).toHaveLength(1);
    expect(await chunksOf(source.id)).toHaveLength(1);
  });

  it("re-indexes a document indexed by an older pipeline", async () => {
    page("/old", "# Old\n\nIndexed long ago.");
    sitemap("/sitemap.xml", ["/old"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    const [document] = await documentsOf(source.id);
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(knowledgeDocuments)
        .set({ contentHash: document!.contentHash!.replace(/^[^:]+:/, "k0:") })
        .where(eq(knowledgeDocuments.id, document!.id));
    });

    mocks.embed.mockClear();
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect((await documentsOf(source.id))[0]?.contentHash).toBe(document!.contentHash);
  });

  it("indexes text with NUL characters instead of failing it forever", async () => {
    page("/nul", "# Nul\n\nText\u0000 with a NUL.");
    sitemap("/sitemap.xml", ["/nul"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    const [document] = await documentsOf(source.id);
    expect(document?.indexStatus).toBe(Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed);
  });

  it("marks a failing page Failed, keeps its chunks, and fails a sync where every page failed", async () => {
    page("/flaky", "# Flaky\n\nWorks the first time.");
    sitemap("/sitemap.xml", ["/flaky"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    expect(await chunksOf(source.id)).toHaveLength(1);

    site.set(`https://${host}/flaky`, { body: "down", type: "text/plain", status: 503 });
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);

    const [document] = await documentsOf(source.id);
    expect(document?.indexStatus).toBe(Schemas.KnowledgeDocumentIndexStatusIntEnum.Failed);
    expect(await chunksOf(source.id)).toHaveLength(1);
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Failed,
    );

    // DEV_NOTE: An unsupported type fails the item without any embed call
    site.set(`https://${host}/flaky`, { body: "png", type: "image/png" });
    mocks.embed.mockClear();
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("records a failed embedding call and fails the page", async () => {
    page("/embed-down", "# Down\n\nCan't embed.");
    sitemap("/sitemap.xml", ["/embed-down"]);
    mocks.embed.mockResolvedValue({
      isSuccess: false,
      message: "Unknown error in embedding knowledge chunks",
      calls: [{ inputTokens: 20, latencyMs: 3, gatewayLogId: null, errorCode: "embed_failed" }],
    });
    const rowsBefore = (await embedRows(companyA)).length;
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);

    expect(await documentsOf(source.id)).toEqual([]);
    const rows = await embedRows(companyA);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.some((row) => row.errorCode === "embed_failed" && Number(row.costUsd) > 0)).toBe(
      true,
    );
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Failed,
    );
  });

  it("rolls back every embed row when one can't be written", async () => {
    const price = KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_EMBEDDING_MODEL)!;
    const result = await withTenant(getDbClient(env), "999999999999", async (tx) => {
      return await KnowledgeModelCallsProvider.record(tx, {
        companyId: "999999999999",
        links: { chatbotId: null, chatbotUserId: null, conversationId: null, turnId: null },
        taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
        model: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
        price,
        calls: [{ inputTokens: 1, latencyMs: 1, gatewayLogId: null, errorCode: null }],
      });
    });
    expect(result.isSuccess).toBe(false);
  });

  it("fails the sync when the sitemap can't be read", async () => {
    const created = await new KnowledgeSourcesRepo(env).createKnowledgeSource({
      companyId: companyA,
      adminId: adminA,
      knowledgeSource: {
        type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap,
        url: `https://${host}/missing-sitemap.xml`,
        syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Manual,
      },
    });
    const publicId = created.knowledgeSource?.publicId ?? "";
    await runSync(companyA, publicId);
    expect((await sourceRow(publicId))?.status).toBe(Schemas.KnowledgeSourceStatusIntEnum.Failed);
  });

  it("marks the source Failed when a step runs out of retries", async () => {
    page("/crash", "# Crash\n\nNever stored.");
    sitemap("/sitemap.xml", ["/crash"]);
    const source = await createSitemapSource(companyA, adminA);
    vi.spyOn(KnowledgeIngestionRepo.prototype, "ingestSyncItem").mockResolvedValue({
      isSuccess: false,
      message: "Unknown error in tenant transaction",
    });

    await expect(runSync(companyA, source.publicId)).rejects.toThrow(
      "Unknown error in tenant transaction",
    );
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Failed,
    );
  });

  it("writes nothing once the source is paused, and refuses to sync it until resumed", async () => {
    page("/paused", "# Paused\n\nNever stored.");
    sitemap("/sitemap.xml", ["/paused"]);
    const source = await createSitemapSource(companyA, adminA);
    const runId = (await sourceRow(source.publicId))!.syncRunId!;
    const repo = new KnowledgeSourcesRepo(env);

    const paused = await repo.updateKnowledgeSource({
      companyId: companyA,
      publicId: source.publicId,
      adminId: adminA,
      knowledgeSource: { status: Schemas.KnowledgeSourceStatusIntEnum.Paused },
    });
    expect(paused.knowledgeSource?.knowledgeSourceStatusLabel).toBe(
      Schemas.KnowledgeSourceStatusLabelEnum.Paused,
    );

    const ingested = await new KnowledgeIngestionRepo(env).ingestSyncItem({
      companyId: companyA,
      knowledgeSourcePublicId: source.publicId,
      syncRunId: runId,
      item: { url: `https://${host}/paused` },
    });
    expect(ingested.outcome).toBe(Schemas.KnowledgeSyncItemOutcomeEnum.Stopped);
    await runSync(companyA, source.publicId, runId);
    expect(await documentsOf(source.id)).toEqual([]);
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Paused,
    );

    const refused = await repo.startSync({ companyId: companyA, publicId: source.publicId });
    expect(refused.failure).toBe(Schemas.KnowledgeSourceFailureEnum.Paused);
  });

  it("stops a page mid-store when the source is paused while it embeds, and deletes its object", async () => {
    page("/mid", "# Mid\n\nPaused while embedding.");
    sitemap("/sitemap.xml", ["/mid"]);
    const source = await createSitemapSource(companyA, adminA);
    const objectsBefore = await objectCount(companyAPublicId);
    const embedOnce = mocks.embed.getMockImplementation()!;
    mocks.embed.mockImplementationOnce(async (...args: [Env, { texts: string[] }]) => {
      await setSource(source.id, { status: Schemas.KnowledgeSourceStatusIntEnum.Paused });
      return await embedOnce(...args);
    });

    await runSync(companyA, source.publicId);

    expect(await documentsOf(source.id)).toEqual([]);
    expect(await chunksOf(source.id)).toEqual([]);
    expect(await objectCount(companyAPublicId)).toBe(objectsBefore);
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Paused,
    );
  });

  it("stops a run left behind by a pause, resume and new sync; only the new run writes", async () => {
    page("/race", "# Race\n\nOnly one copy.");
    sitemap("/sitemap.xml", ["/race"]);
    const source = await createSitemapSource(companyA, adminA);
    const oldRun = (await sourceRow(source.publicId))!.syncRunId!;
    const repo = new KnowledgeSourcesRepo(env);
    for (const status of [
      Schemas.KnowledgeSourceStatusIntEnum.Paused,
      Schemas.KnowledgeSourceStatusIntEnum.Active,
    ] as const) {
      await repo.updateKnowledgeSource({
        companyId: companyA,
        publicId: source.publicId,
        adminId: adminA,
        knowledgeSource: { status },
      });
    }
    expect(
      (await repo.startSync({ companyId: companyA, publicId: source.publicId })).isSuccess,
    ).toBe(true);
    const newRun = (await sourceRow(source.publicId))!.syncRunId!;
    expect(newRun).not.toBe(oldRun);

    const ingestion = new KnowledgeIngestionRepo(env);
    const stale = {
      companyId: companyA,
      knowledgeSourcePublicId: source.publicId,
      syncRunId: oldRun,
    };
    expect((await ingestion.listSyncItems({ ...stale, round: 0 })).isStopped).toBe(true);
    expect(
      (await ingestion.ingestSyncItem({ ...stale, item: { url: `https://${host}/race` } })).outcome,
    ).toBe(Schemas.KnowledgeSyncItemOutcomeEnum.Stopped);
    await ingestion.finishSync({ ...stale, isFailed: true });
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Syncing,
    );

    await runSync(companyA, source.publicId, newRun);
    expect(await documentsOf(source.id)).toHaveLength(1);
  });

  it("never stores one page twice for a source", async () => {
    page("/once", "# Once\n\nUnique.");
    sitemap("/sitemap.xml", ["/once"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    const [document] = await documentsOf(source.id);

    await expect(
      withOwnerDb(async (ownerDb) => {
        await ownerDb.insert(knowledgeDocuments).values({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          knowledgeSourceId: source.id,
          fileId: "999999999999",
          sourceUrl: document!.sourceUrl,
        });
      }),
    ).rejects.toThrow();
  });

  it("refuses a second sync while one runs, but re-claims one whose heartbeat went stale", async () => {
    sitemap("/sitemap.xml", []);
    const source = await createSitemapSource(companyA, adminA);
    const repo = new KnowledgeSourcesRepo(env);

    expect((await repo.startSync({ companyId: companyA, publicId: source.publicId })).failure).toBe(
      Schemas.KnowledgeSourceFailureEnum.AlreadySyncing,
    );

    // DEV_NOTE: An admin edit refreshes updated_at but not the heartbeat, so it doesn't keep a dead sync alive
    await setSource(source.id, { syncHeartbeatAt: new Date(Date.now() - 7 * 60 * 60_000) });
    await repo.updateKnowledgeSource({
      companyId: companyA,
      publicId: source.publicId,
      adminId: adminA,
      knowledgeSource: { syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Weekly },
    });
    expect(
      (await repo.startSync({ companyId: companyA, publicId: source.publicId })).isSuccess,
    ).toBe(true);
  });

  it("puts the source in Failed when its workflow can't start", async () => {
    sitemap("/sitemap.xml", []);
    mocks.startWorkflow.mockResolvedValueOnce({ isSuccess: false, message: "Workflow down" });
    const source = await createSitemapSource(companyA, adminA);
    expect(source.created.knowledgeSource?.knowledgeSourceStatus).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Failed,
    );
  });

  it("indexes an uploaded file from R2 and deletes it with its object", async () => {
    const source = await createUploadSource(companyA, adminA);
    expect(source.created.knowledgeSource?.syncFrequency).toBeNull();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();

    const uploaded = await upload(
      source.publicId,
      "leave.md",
      "# Leave policy\n\nTwenty days a year.",
    );
    expect(uploaded.isSuccess).toBe(true);
    expect(uploaded.knowledgeDocument?.knowledgeDocumentIndexStatus).toBe(
      Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending,
    );
    expect(uploaded.knowledgeDocument).not.toHaveProperty("fileId");
    expect(uploaded.knowledgeDocument).not.toHaveProperty("contentHash");
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);

    await runSync(companyA, source.publicId);
    const repo = new KnowledgeSourcesRepo(env);
    const listed = await repo.getKnowledgeDocuments({
      companyId: companyA,
      publicId: source.publicId,
    });
    expect(
      listed.knowledgeDocuments?.map((document) => [
        document.title,
        document.knowledgeDocumentIndexStatusLabel,
      ]),
    ).toEqual([["Leave policy", Schemas.KnowledgeDocumentIndexStatusLabelEnum.Indexed]]);

    const [document] = await documentsOf(source.id);
    const [key] = await fileKeysOf(companyA, [document!.fileId]);
    expect(await env.FILES_BUCKET.head(key!)).not.toBeNull();

    const deleted = await repo.deleteKnowledgeDocument({
      companyId: companyA,
      publicId: source.publicId,
      documentPublicId: document!.publicId,
    });
    expect(deleted.isSuccess).toBe(true);
    expect(await documentsOf(source.id)).toEqual([]);
    expect(await chunksOf(source.id)).toEqual([]);
    expect(await env.FILES_BUCKET.head(key!)).toBeNull();
  });

  it("re-reads only uploads with work to do", async () => {
    const source = await createUploadSource(companyA, adminA);
    await upload(source.publicId, "first.md", "# First\n\nOne.");
    await runSync(companyA, source.publicId);
    const [first] = await documentsOf(source.id);

    await upload(source.publicId, "second.md", "# Second\n\nTwo.");
    await runSync(companyA, source.publicId);

    const documents = await documentsOf(source.id);
    expect(
      documents.every(
        (row) => row.indexStatus === Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
      ),
    ).toBe(true);
    // DEV_NOTE: The first file wasn't listed again: its last sync didn't move
    expect(documents.find((row) => row.id === first!.id)?.lastSyncedAt).toEqual(
      first!.lastSyncedAt,
    );
  });

  it("starts a follow-up sync when uploads are still Pending at the end", async () => {
    const source = await createUploadSource(companyA, adminA);
    await upload(source.publicId, "late.md", "# Late\n\nArrived late.");
    mocks.startWorkflow.mockClear();
    vi.spyOn(KnowledgeIngestionRepo.prototype, "listSyncItems").mockResolvedValue({
      isSuccess: true,
      items: [],
      isWebSource: false,
      isComplete: false,
    });

    await runSync(companyA, source.publicId);

    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Syncing,
    );
  });

  it("syncs a resumed upload source's pending files", async () => {
    const source = await createUploadSource(companyA, adminA);
    const repo = new KnowledgeSourcesRepo(env);
    await repo.updateKnowledgeSource({
      companyId: companyA,
      publicId: source.publicId,
      adminId: adminA,
      knowledgeSource: { status: Schemas.KnowledgeSourceStatusIntEnum.Paused },
    });
    await upload(source.publicId, "paused.md", "# Paused\n\nWaits.");
    expect(mocks.startWorkflow).not.toHaveBeenCalled();

    const resumed = await repo.updateKnowledgeSource({
      companyId: companyA,
      publicId: source.publicId,
      adminId: adminA,
      knowledgeSource: { status: Schemas.KnowledgeSourceStatusIntEnum.Active },
    });
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
    expect(resumed.knowledgeSource?.knowledgeSourceStatus).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Syncing,
    );
  });

  it("refuses bad uploads and a sync frequency on an upload source", async () => {
    sitemap("/sitemap.xml", []);
    const web = await createSitemapSource(companyA, adminA);
    const repo = new KnowledgeSourcesRepo(env);
    const toWeb = await repo.uploadKnowledgeDocument({
      companyId: companyA,
      publicId: web.publicId,
      adminId: adminA,
      file: new File(["text"], "a.txt", { type: "text/plain" }),
    });
    expect(toWeb.failure).toBe(Schemas.KnowledgeSourceFailureEnum.NotUploadSource);

    const source = await createUploadSource(companyA, adminA);
    const objectsBefore = await objectCount(companyAPublicId);
    const fakePdf = await upload(source.publicId, "fake.pdf", "not a pdf", "application/pdf");
    expect(fakePdf.failure).toBe(Schemas.KnowledgeSourceFailureEnum.UnreadableFile);
    expect(await objectCount(companyAPublicId)).toBe(objectsBefore);

    const updated = await repo.updateKnowledgeSource({
      companyId: companyA,
      publicId: source.publicId,
      adminId: adminA,
      knowledgeSource: { syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily },
    });
    expect(updated.failure).toBe(Schemas.KnowledgeSourceFailureEnum.NotWebSource);
  });

  it("deletes a source with every document, chunk, file row and object", async () => {
    page("/gone", "# Gone\n\nSoon deleted.");
    sitemap("/sitemap.xml", ["/gone"]);
    const source = await createSitemapSource(companyA, adminA);
    const runId = (await sourceRow(source.publicId))!.syncRunId!;
    await runSync(companyA, source.publicId, runId);
    const [document] = await documentsOf(source.id);
    const [key] = await fileKeysOf(companyA, [document!.fileId]);

    const deleted = await new KnowledgeSourcesRepo(env).deleteKnowledgeSource({
      companyId: companyA,
      publicId: source.publicId,
    });
    expect(deleted.isSuccess).toBe(true);
    expect(await sourceRow(source.publicId)).toBeUndefined();
    expect(await documentsOf(source.id)).toEqual([]);
    expect(await chunksOf(source.id)).toEqual([]);
    expect(await fileKeysOf(companyA, [document!.fileId])).toEqual([]);
    expect(await env.FILES_BUCKET.head(key!)).toBeNull();

    const ingested = await new KnowledgeIngestionRepo(env).ingestSyncItem({
      companyId: companyA,
      knowledgeSourcePublicId: source.publicId,
      syncRunId: runId,
      item: { url: `https://${host}/gone` },
    });
    expect(ingested.outcome).toBe(Schemas.KnowledgeSyncItemOutcomeEnum.Stopped);
  });

  it("starts due syncs only (Cron)", async () => {
    sitemap("/sitemap.xml", []);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000);
    const make = async (
      frequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum,
      values: Partial<typeof knowledgeSources.$inferInsert>,
    ) => {
      const source = await createSitemapSource(companyB, adminB, frequency);
      await setSource(source.id, values);
      return source.publicId;
    };
    const { Daily, Weekly, Manual } = Schemas.KnowledgeSourceSyncFrequencyIntEnum;
    const { Active, Failed, Paused, Syncing } = Schemas.KnowledgeSourceStatusIntEnum;
    const due = [
      await make(Daily, { status: Active, lastSyncedAt: hoursAgo(48) }),
      await make(Weekly, { status: Active, lastSyncedAt: hoursAgo(8 * 24) }),
      await make(Daily, { status: Active, lastSyncedAt: null }),
      await make(Daily, { status: Failed, syncHeartbeatAt: hoursAgo(7) }),
      await make(Daily, { status: Syncing, syncHeartbeatAt: hoursAgo(7) }),
    ];
    const notDue = [
      await make(Daily, { status: Active, lastSyncedAt: hoursAgo(1) }),
      await make(Weekly, { status: Active, lastSyncedAt: hoursAgo(48) }),
      await make(Daily, { status: Paused, lastSyncedAt: hoursAgo(48) }),
      await make(Daily, { status: Failed, syncHeartbeatAt: hoursAgo(1) }),
      await make(Manual, { status: Failed, syncHeartbeatAt: hoursAgo(48) }),
      await make(Daily, { status: Syncing, syncHeartbeatAt: new Date() }),
    ];
    mocks.startWorkflow.mockClear();

    const result = await new KnowledgeSourcesRepo(env).startDueSyncs({ companyIds: [companyB] });

    expect(result).toMatchObject({ isSuccess: true, startedCount: due.length, failedCount: 0 });
    const started = mocks.startWorkflow.mock.calls.map(
      (call) => (call[1] as Schemas.KnowledgeSyncWorkflowParams).knowledgeSourcePublicId,
    );
    expect(started.sort()).toEqual([...due].sort());
    expect(started.some((publicId) => notDue.includes(publicId))).toBe(false);
  });

  it("never reads or writes another company's source or documents", async () => {
    page("/private", "# Private\n\nCompany A only.");
    sitemap("/sitemap.xml", ["/private"]);
    const source = await createSitemapSource(companyA, adminA);
    const runId = (await sourceRow(source.publicId))!.syncRunId!;
    await runSync(companyA, source.publicId, runId);
    const repo = new KnowledgeSourcesRepo(env);

    expect(
      (await repo.getKnowledgeSourceDetails({ companyId: companyB, publicId: source.publicId }))
        .isNotFound,
    ).toBe(true);
    const listed = await repo.getKnowledgeSources({ companyId: companyB });
    expect(listed.knowledgeSources?.some((row) => row.publicId === source.publicId)).toBe(false);
    expect(
      (await repo.getKnowledgeDocuments({ companyId: companyB, publicId: source.publicId }))
        .isNotFound,
    ).toBe(true);
    expect(
      (
        await repo.updateKnowledgeSource({
          companyId: companyB,
          publicId: source.publicId,
          adminId: adminB,
          knowledgeSource: { status: Schemas.KnowledgeSourceStatusIntEnum.Paused },
        })
      ).isNotFound,
    ).toBe(true);
    expect(
      (await repo.startSync({ companyId: companyB, publicId: source.publicId })).isNotFound,
    ).toBe(true);
    expect(
      (await repo.deleteKnowledgeSource({ companyId: companyB, publicId: source.publicId }))
        .isNotFound,
    ).toBe(true);

    // DEV_NOTE: A sync step run under the wrong company finds no source and writes nothing
    const ingestion = new KnowledgeIngestionRepo(env);
    const wrong = {
      companyId: companyB,
      knowledgeSourcePublicId: source.publicId,
      syncRunId: runId,
    };
    expect(
      (await ingestion.ingestSyncItem({ ...wrong, item: { url: `https://${host}/private` } }))
        .outcome,
    ).toBe(Schemas.KnowledgeSyncItemOutcomeEnum.Stopped);
    expect((await ingestion.finishSync({ ...wrong, isFailed: true })).isSuccess).toBe(true);
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Active,
    );
    expect(await documentsOf(source.id)).toHaveLength(1);
  });
});

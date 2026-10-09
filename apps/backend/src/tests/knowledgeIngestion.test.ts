import { env } from "cloudflare:test";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
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
// returns; the workflow start is recorded instead of creating an instance. Pages are served as text/markdown, which
// KnowledgeExtractProvider reads without Workers AI.
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

// DEV_NOTE: Runs the real workflow body with a step runner that just calls each step once, as Workflows does on a
// first run with no failures
async function runSync(companyId: string, knowledgeSourcePublicId: string) {
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
      payload: { companyId, knowledgeSourcePublicId },
      timestamp: new Date(),
      instanceId: "test",
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

async function createSitemapSource(companyId: string, adminId: string) {
  const repo = new KnowledgeSourcesRepo(env);
  const created = await repo.createKnowledgeSource({
    companyId,
    adminId,
    knowledgeSource: {
      type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap,
      url: `https://${host}/sitemap.xml`,
      syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
    },
  });
  expect(created.isSuccess).toBe(true);
  const publicId = created.knowledgeSource?.publicId ?? "";
  const row = await sourceRow(publicId);
  return { publicId, id: row!.id, created };
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Knowledge A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Knowledge B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
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

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const entry = site.get(url);
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(entry.body, {
      status: entry.status ?? 200,
      headers: { "content-type": entry.type },
    });
  });
});

beforeEach(() => {
  mocks.embed.mockReset();
  mocks.embed.mockImplementation(async (_env: Env, params: { texts: string[] }) => {
    const calls: Schemas.KnowledgeEmbedCall[] = [];
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

afterAll(async () => {
  vi.restoreAllMocks();
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

describe("knowledge sync (M2-5)", () => {
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
    expect(mocks.startWorkflow).toHaveBeenCalledWith(expect.anything(), {
      companyId: companyA,
      knowledgeSourcePublicId: source.publicId,
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
    expect(chunks.map((chunk) => chunk.headingPath).sort()).toEqual([
      "Billing",
      "Billing > Refunds",
      "Setup",
    ]);
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
      expect(row.inputTokens).toBeGreaterThan(0);
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
    const documentsAfter = await documentsOf(source.id);
    for (const document of documentsAfter) {
      const before = documents.find((row) => row.id === document.id);
      expect(document.lastSyncedAt!.getTime()).toBeGreaterThan(before!.lastSyncedAt!.getTime());
      expect(document.contentHash).toBe(before!.contentHash);
    }
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Active,
    );
  });

  it("re-embeds only a changed page and prunes a page gone from the sitemap", async () => {
    page("/a", "# Alpha\n\nFirst version.");
    page("/b", "# Bravo\n\nStays the same.");
    sitemap("/sitemap.xml", ["/a", "/b"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    const before = await documentsOf(source.id);
    const bravo = before.find((document) => document.title === "Bravo")!;
    const [bravoKey] = await fileKeysOf(companyA, [bravo.fileId]);

    page("/a", "# Alpha\n\nSecond version, longer than before.");
    sitemap("/sitemap.xml", ["/a"]);
    mocks.embed.mockClear();
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.embed.mock.calls[0]?.[1]?.texts).toEqual([
      "Alpha\n\nSecond version, longer than before.",
    ]);
    const after = await documentsOf(source.id);
    expect(after.map((document) => document.title)).toEqual(["Alpha"]);
    const alpha = after[0]!;
    expect(alpha.contentHash).not.toBe(
      before.find((document) => document.title === "Alpha")!.contentHash,
    );
    const chunks = await chunksOf(source.id);
    expect(chunks.every((chunk) => chunk.knowledgeDocumentId === alpha.id)).toBe(true);
    expect(await fileKeysOf(companyA, [bravo.fileId])).toEqual([]);
    expect(await env.FILES_BUCKET.head(bravoKey!)).toBeNull();
    const [alphaKey] = await fileKeysOf(companyA, [alpha.fileId]);
    expect(await (await env.FILES_BUCKET.get(alphaKey!))?.text()).toBe(
      "# Alpha\n\nSecond version, longer than before.",
    );
  });

  it("marks a failing page Failed, keeps its chunks, and fails a sync where every page failed", async () => {
    page("/flaky", "# Flaky\n\nWorks the first time.");
    sitemap("/sitemap.xml", ["/flaky"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
    const chunks = await chunksOf(source.id);
    expect(chunks).toHaveLength(1);

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

    // DEV_NOTE: An unsupported type fails the item without any Workers AI call
    site.set(`https://${host}/flaky`, { body: "png", type: "image/png" });
    mocks.embed.mockClear();
    await new KnowledgeSourcesRepo(env).startSync({
      companyId: companyA,
      publicId: source.publicId,
    });
    await runSync(companyA, source.publicId);
    expect(mocks.embed).not.toHaveBeenCalled();
    site.set(`https://${host}/flaky`, {
      body: "# Flaky\n\nWorks the first time.",
      type: "text/markdown",
    });
  });

  it("fails the sync when the sitemap can't be read", async () => {
    const repo = new KnowledgeSourcesRepo(env);
    const created = await repo.createKnowledgeSource({
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

  it("writes nothing once the source is paused, and refuses to sync it until resumed", async () => {
    page("/paused", "# Paused\n\nNever stored.");
    sitemap("/sitemap.xml", ["/paused"]);
    const source = await createSitemapSource(companyA, adminA);
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
      item: { url: `https://${host}/paused` },
    });
    expect(ingested.outcome).toBe(Schemas.KnowledgeSyncItemOutcomeEnum.Stopped);
    await runSync(companyA, source.publicId);
    expect(await documentsOf(source.id)).toEqual([]);
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Paused,
    );

    const refused = await repo.startSync({ companyId: companyA, publicId: source.publicId });
    expect(refused.failure).toBe(Schemas.KnowledgeSourceFailureEnum.Paused);

    const resumed = await repo.updateKnowledgeSource({
      companyId: companyA,
      publicId: source.publicId,
      adminId: adminA,
      knowledgeSource: { status: Schemas.KnowledgeSourceStatusIntEnum.Active },
    });
    expect(resumed.knowledgeSource?.knowledgeSourceStatus).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Active,
    );
    expect(
      (await repo.startSync({ companyId: companyA, publicId: source.publicId })).isSuccess,
    ).toBe(true);
  });

  it("refuses a second sync while one runs, but re-claims a stale one", async () => {
    sitemap("/sitemap.xml", []);
    const source = await createSitemapSource(companyA, adminA);
    const repo = new KnowledgeSourcesRepo(env);

    const second = await repo.startSync({ companyId: companyA, publicId: source.publicId });
    expect(second.failure).toBe(Schemas.KnowledgeSourceFailureEnum.AlreadySyncing);

    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(knowledgeSources)
        .set({ updatedAt: new Date(Date.now() - 7 * 60 * 60_000) })
        .where(eq(knowledgeSources.id, source.id));
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
    const repo = new KnowledgeSourcesRepo(env);
    const created = await repo.createKnowledgeSource({
      companyId: companyA,
      adminId: adminA,
      knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Upload },
    });
    const publicId = created.knowledgeSource?.publicId ?? "";
    expect(created.knowledgeSource?.syncFrequency).toBeNull();
    expect(mocks.startWorkflow).not.toHaveBeenCalled();

    const uploaded = await repo.uploadKnowledgeDocument({
      companyId: companyA,
      publicId,
      adminId: adminA,
      file: new File(["# Leave policy\n\nTwenty days a year."], "leave.md", { type: "" }),
    });
    expect(uploaded.isSuccess).toBe(true);
    expect(uploaded.knowledgeDocument?.knowledgeDocumentIndexStatus).toBe(
      Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending,
    );
    expect(uploaded.knowledgeDocument).not.toHaveProperty("fileId");
    expect(uploaded.knowledgeDocument).not.toHaveProperty("contentHash");
    expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);

    await runSync(companyA, publicId);
    const listed = await repo.getKnowledgeDocuments({ companyId: companyA, publicId });
    expect(
      listed.knowledgeDocuments?.map((document) => [
        document.title,
        document.knowledgeDocumentIndexStatusLabel,
      ]),
    ).toEqual([["Leave policy", Schemas.KnowledgeDocumentIndexStatusLabelEnum.Indexed]]);
    expect(
      (await repo.getKnowledgeDocumentsCount({ companyId: companyA, publicId })).totalRecords,
    ).toBe(1);

    const row = await sourceRow(publicId);
    const [document] = await documentsOf(row!.id);
    const [key] = await fileKeysOf(companyA, [document!.fileId]);
    expect(await env.FILES_BUCKET.head(key!)).not.toBeNull();

    const deleted = await repo.deleteKnowledgeDocument({
      companyId: companyA,
      publicId,
      documentPublicId: document!.publicId,
    });
    expect(deleted.isSuccess).toBe(true);
    expect(await documentsOf(row!.id)).toEqual([]);
    expect(await chunksOf(row!.id)).toEqual([]);
    expect(await env.FILES_BUCKET.head(key!)).toBeNull();
  });

  it("refuses an upload to a web source and a sync frequency on an upload source", async () => {
    sitemap("/sitemap.xml", []);
    const web = await createSitemapSource(companyA, adminA);
    const repo = new KnowledgeSourcesRepo(env);
    const uploaded = await repo.uploadKnowledgeDocument({
      companyId: companyA,
      publicId: web.publicId,
      adminId: adminA,
      file: new File(["text"], "a.txt", { type: "text/plain" }),
    });
    expect(uploaded.failure).toBe(Schemas.KnowledgeSourceFailureEnum.NotUploadSource);

    const upload = await repo.createKnowledgeSource({
      companyId: companyA,
      adminId: adminA,
      knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Upload },
    });
    const updated = await repo.updateKnowledgeSource({
      companyId: companyA,
      publicId: upload.knowledgeSource?.publicId ?? "",
      adminId: adminA,
      knowledgeSource: { syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily },
    });
    expect(updated.failure).toBe(Schemas.KnowledgeSourceFailureEnum.NotWebSource);
  });

  it("deletes a source with every document, chunk, file row and object", async () => {
    page("/gone", "# Gone\n\nSoon deleted.");
    sitemap("/sitemap.xml", ["/gone"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
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

    // DEV_NOTE: A sync step after the delete stops without writing
    const ingested = await new KnowledgeIngestionRepo(env).ingestSyncItem({
      companyId: companyA,
      knowledgeSourcePublicId: source.publicId,
      item: { url: `https://${host}/gone` },
    });
    expect(ingested.outcome).toBe(Schemas.KnowledgeSyncItemOutcomeEnum.Stopped);
  });

  it("starts due syncs only (Cron)", async () => {
    sitemap("/sitemap.xml", []);
    const due = await createSitemapSource(companyB, adminB);
    const fresh = await createSitemapSource(companyB, adminB);
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(knowledgeSources)
        .set({
          status: Schemas.KnowledgeSourceStatusIntEnum.Active,
          lastSyncedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
        })
        .where(eq(knowledgeSources.id, due.id));
      await ownerDb
        .update(knowledgeSources)
        .set({ status: Schemas.KnowledgeSourceStatusIntEnum.Active, lastSyncedAt: new Date() })
        .where(eq(knowledgeSources.id, fresh.id));
    });
    mocks.startWorkflow.mockClear();

    const result = await new KnowledgeSourcesRepo(env).startDueSyncs({ companyIds: [companyB] });

    expect(result).toMatchObject({ isSuccess: true, startedCount: 1, failedCount: 0 });
    expect(mocks.startWorkflow).toHaveBeenCalledWith(expect.anything(), {
      companyId: companyB,
      knowledgeSourcePublicId: due.publicId,
    });
    expect((await sourceRow(fresh.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Active,
    );
  });

  it("never reads or writes another company's source or documents", async () => {
    page("/private", "# Private\n\nCompany A only.");
    sitemap("/sitemap.xml", ["/private"]);
    const source = await createSitemapSource(companyA, adminA);
    await runSync(companyA, source.publicId);
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
    const ingested = await new KnowledgeIngestionRepo(env).ingestSyncItem({
      companyId: companyB,
      knowledgeSourcePublicId: source.publicId,
      item: { url: `https://${host}/private` },
    });
    expect(ingested.outcome).toBe(Schemas.KnowledgeSyncItemOutcomeEnum.Stopped);
    const finished = await new KnowledgeIngestionRepo(env).finishSync({
      companyId: companyB,
      knowledgeSourcePublicId: source.publicId,
      isFailed: true,
    });
    expect(finished.isSuccess).toBe(true);
    expect((await sourceRow(source.publicId))?.status).toBe(
      Schemas.KnowledgeSourceStatusIntEnum.Active,
    );
    expect(await documentsOf(source.id)).toHaveLength(1);
  });
  it("prunes nothing when the sitemap comes back empty", async () => {
    page("/kept", "# Kept\n\nStill here.");
    sitemap("/sitemap.xml", ["/kept"]);
    const source = await createSitemapSource(companyA, adminA);
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
});

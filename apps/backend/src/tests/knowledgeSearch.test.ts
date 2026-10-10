import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import getDbClient from "@/db/dbClient";
import {
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  files,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
  modelCalls,
} from "@/db/tables";
import withTenant from "@/db/withTenant";
import Constants from "@/config/Constants";
import KnowledgeSearchRepo from "@/repositories/KnowledgeSearchRepo";
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

// DEV_NOTE: Workers AI is never reached from a test (remoteBindings: false). The embed provider answers the query with
// a fixed vector along axis 0; the reranker scores a candidate high when it mentions the query's first word, so what
// reaches the hits is decided by the source filter and the min score, not by the mock. Both report one call each,
// exactly the shapes the real providers return (tested in knowledgeProviders / knowledgeSearchProviders).
const mocks = vi.hoisted(() => ({ embed: vi.fn(), rerank: vi.fn() }));
vi.mock("@/providers/knowledgeEmbed", () => ({ default: { embed: mocks.embed } }));
vi.mock("@/providers/knowledgeRerank", () => ({ default: { rerank: mocks.rerank } }));

// DEV_NOTE: Tests hit the Neon staging branch. The Repo and DALs run as diletta_app (HYPERDRIVE), so RLS applies;
// fixtures, row counts and cleanup run as the owner. Chunks are written directly with chosen vectors.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let ownerPool: Pool | null = null;
const createdCompanyIds: string[] = [];

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  ownerPool ??= new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  return await run(drizzle({ client: ownerPool }));
}

// DEV_NOTE: A unit vector along one axis, tilted towards axis 1 by tilt: a smaller tilt is closer to the query
function vector(axis: number, tilt = 0): number[] {
  const values = new Array<number>(Schemas.KNOWLEDGE_EMBEDDING_DIMENSIONS).fill(0);
  values[axis] = 1;
  if (tilt > 0) values[1] = (values[1] ?? 0) + tilt;
  return values;
}

type Tenant = Awaited<ReturnType<typeof createTenant>>;

async function createTenant() {
  return await withOwnerDb(async (ownerDb) => {
    const [company] = await ownerDb
      .insert(companies)
      .values({ publicId: Utility.generatePublicId(), name: `Search ${crypto.randomUUID()}` })
      .returning({ id: companies.id, publicId: companies.publicId });
    const companyId = company?.id ?? "";
    createdCompanyIds.push(companyId);
    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        name: "Help bot",
        isDefault: true,
      })
      .returning({ id: chatbots.id });
    const [chatbotUser] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId, hostUserId: `host-${crypto.randomUUID()}` })
      .returning({ id: chatbotUsers.id });
    const [conversation] = await ownerDb
      .insert(conversations)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        chatbotId: chatbot?.id ?? "",
        chatbotUserId: chatbotUser?.id ?? "",
      })
      .returning({ id: conversations.id });
    return {
      companyId,
      companyPublicId: company?.publicId ?? "",
      chatbotId: chatbot?.id ?? "",
      chatbotUserId: chatbotUser?.id ?? "",
      conversationId: conversation?.id ?? "",
    };
  });
}

async function createSource(tenant: Tenant, status = Schemas.KnowledgeSourceStatusIntEnum.Active) {
  return await withOwnerDb(async (ownerDb) => {
    const [source] = await ownerDb
      .insert(knowledgeSources)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: tenant.companyId,
        type: Schemas.KnowledgeSourceTypeIntEnum.Upload,
        status,
      })
      .returning({ id: knowledgeSources.id, publicId: knowledgeSources.publicId });
    return { id: source?.id ?? "", publicId: source?.publicId ?? "" };
  });
}

// DEV_NOTE: One document with its file row and chunks, as ingestion leaves them
async function createDocument(
  tenant: Tenant,
  sourceId: string,
  title: string,
  chunks: { text: string; embedding: number[]; embeddingModel?: string }[],
  indexStatus = Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
) {
  return await withOwnerDb(async (ownerDb) => {
    const [file] = await ownerDb
      .insert(files)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: tenant.companyId,
        ownerType: Schemas.FileOwnerTypeEnum.KnowledgeDocument,
        ownerId: "0",
        filename: `${title}.md`,
        mime: "text/markdown",
        sizeBytes: 10,
        sha256: crypto.randomUUID(),
      })
      .returning({ id: files.id });
    const [document] = await ownerDb
      .insert(knowledgeDocuments)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: tenant.companyId,
        knowledgeSourceId: sourceId,
        fileId: file?.id ?? "",
        title,
        sourceUrl: null,
        indexStatus,
      })
      .returning({ id: knowledgeDocuments.id, publicId: knowledgeDocuments.publicId });
    await ownerDb
      .update(files)
      .set({ ownerId: document?.id ?? "0" })
      .where(eq(files.id, file?.id ?? ""));
    await ownerDb.insert(knowledgeChunks).values(
      chunks.map((chunk, chunkIndex) => ({
        companyId: tenant.companyId,
        knowledgeDocumentId: document?.id ?? "",
        knowledgeSourceId: sourceId,
        chunkIndex,
        headingPath: null,
        text: chunk.text,
        embedding: chunk.embedding,
        embeddingModel: chunk.embeddingModel ?? Schemas.KNOWLEDGE_EMBEDDING_MODEL,
      })),
    );
    return { id: document?.id ?? "", publicId: document?.publicId ?? "" };
  });
}

// DEV_NOTE: A waitUntil that keeps the promises, so a test can wait for the model_calls rows
function testContext() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
    settle: async () => {
      await Promise.all(pending);
    },
  };
}

async function search(
  tenant: Tenant,
  sourcePublicIds: string[],
  options: { query?: string; topK?: number; ctx?: ReturnType<typeof testContext>["ctx"] } = {},
) {
  return await new KnowledgeSearchRepo(env, options.ctx ?? testContext().ctx).search({
    companyId: tenant.companyId,
    chatbotId: tenant.chatbotId,
    chatbotUserId: tenant.chatbotUserId,
    conversationId: tenant.conversationId,
    turnId: Utility.generateUlid(),
    sourcePublicIds,
    topK: options.topK ?? 5,
    query: options.query ?? "refund policy",
  });
}

const titlesOf = (response: Schemas.SearchKnowledgeResponse) =>
  (response.hits ?? []).map((hit) => hit.title).sort();

let tenantA: Tenant;
let tenantB: Tenant;
let sourceA1: Awaited<ReturnType<typeof createSource>>;
let sourceA2: Awaited<ReturnType<typeof createSource>>;
let pausedSource: Awaited<ReturnType<typeof createSource>>;
let sourceB: Awaited<ReturnType<typeof createSource>>;

beforeAll(async () => {
  tenantA = await createTenant();
  tenantB = await createTenant();
  sourceA1 = await createSource(tenantA);
  sourceA2 = await createSource(tenantA);
  pausedSource = await createSource(tenantA, Schemas.KnowledgeSourceStatusIntEnum.Paused);
  sourceB = await createSource(tenantB);

  await createDocument(tenantA, sourceA1.id, "A1 refunds", [
    { text: "Refund policy: refunds take 5 days.", embedding: vector(0, 0.1) },
    { text: "Shipping takes a week.", embedding: vector(2) },
  ]);
  await createDocument(tenantA, sourceA2.id, "A2 refunds", [
    { text: "Refund requests go through billing.", embedding: vector(0, 0.3) },
  ]);
  await createDocument(tenantA, pausedSource.id, "Paused refunds", [
    { text: "Refund rules for paused source.", embedding: vector(0, 0.2) },
  ]);
  await createDocument(
    tenantA,
    sourceA1.id,
    "Pending refunds",
    [{ text: "Refund draft not indexed yet.", embedding: vector(0) }],
    Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending,
  );
  await createDocument(tenantA, sourceA1.id, "Old model refunds", [
    { text: "Refund text from another model.", embedding: vector(0), embeddingModel: "@cf/old" },
  ]);
  await createDocument(tenantB, sourceB.id, "B refunds", [
    { text: "Refund policy of company B.", embedding: vector(0) },
  ]);
});

beforeEach(() => {
  mocks.embed.mockReset();
  mocks.embed.mockImplementation(async () => ({
    isSuccess: true,
    embeddings: [vector(0)],
    calls: [{ inputTokens: 15, latencyMs: 5, gatewayLogId: "log-embed", errorCode: null }],
  }));
  mocks.rerank.mockReset();
  mocks.rerank.mockImplementation(async (_env: Env, params: { query: string; texts: string[] }) => {
    const word = params.query.split(" ")[0]?.toLowerCase() ?? "";
    return {
      isSuccess: true,
      scores: params.texts.map((text) => (text.toLowerCase().includes(word) ? 0.9 : 0.05)),
      call: { inputTokens: 300, latencyMs: 7, gatewayLogId: "log-rerank", errorCode: null },
    };
  });
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  try {
    if (companyIds.length === 0) return;
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(modelCalls).where(inArray(modelCalls.companyId, companyIds));
      await ownerDb.delete(knowledgeChunks).where(inArray(knowledgeChunks.companyId, companyIds));
      await ownerDb
        .delete(knowledgeDocuments)
        .where(inArray(knowledgeDocuments.companyId, companyIds));
      await ownerDb.delete(files).where(inArray(files.companyId, companyIds));
      await ownerDb.delete(knowledgeSources).where(inArray(knowledgeSources.companyId, companyIds));
      await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
      await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
      await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    });
  } finally {
    await ownerPool?.end();
  }
});

describe("Knowledge search source filter", () => {
  it("searches only the chatbot's sources", async () => {
    // DEV_NOTE: The Done-when: the same company, the same query, three source lists, three answers
    expect(titlesOf(await search(tenantA, [sourceA1.publicId]))).toEqual(["A1 refunds"]);
    expect(titlesOf(await search(tenantA, [sourceA2.publicId]))).toEqual(["A2 refunds"]);
    expect(titlesOf(await search(tenantA, [sourceA1.publicId, sourceA2.publicId]))).toEqual([
      "A1 refunds",
      "A2 refunds",
    ]);
  });

  it("still searches a paused source (pausing stops syncing only)", async () => {
    expect(titlesOf(await search(tenantA, [pausedSource.publicId]))).toEqual(["Paused refunds"]);
  });

  it("leaves out documents not yet indexed and chunks of another embedding model", async () => {
    const titles = titlesOf(await search(tenantA, [sourceA1.publicId]));
    expect(titles).not.toContain("Pending refunds");
    expect(titles).not.toContain("Old model refunds");
  });

  it("makes no model call when none of the sources exist in the company", async () => {
    const response = await search(tenantA, [sourceB.publicId, "ks_missing"]);
    expect(response).toMatchObject({ isSuccess: true, hits: [] });
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.rerank).not.toHaveBeenCalled();
    expect(await search(tenantA, [])).toMatchObject({ isSuccess: true, hits: [] });
    expect(await search(tenantA, [sourceA1.publicId], { query: "   " })).toMatchObject({
      isSuccess: true,
      hits: [],
    });
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("never reaches another company's chunks, even given their internal source ids (as diletta_app)", async () => {
    const db = getDbClient(env);
    const dal = new KnowledgeChunksDAL();
    const side = {
      companyId: tenantB.companyId,
      knowledgeSourceIds: [sourceA1.id, sourceA2.id],
      embeddingModel: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
      limit: 10,
    };
    const matched = await withTenant(db, tenantB.companyId, async (tx) => {
      const vectorSide = await dal.searchKnowledgeChunksByVector(tx, {
        ...side,
        embedding: vector(0),
        efSearch: 100,
      });
      const keywordSide = await dal.searchKnowledgeChunksByKeyword(tx, {
        ...side,
        query: "refund",
      });
      return {
        isSuccess: vectorSide.isSuccess && keywordSide.isSuccess,
        count: (vectorSide.matches?.length ?? 0) + (keywordSide.matches?.length ?? 0),
      };
    });
    expect(matched).toEqual({ isSuccess: true, count: 0 });

    const ids = await withTenant(db, tenantB.companyId, async (tx) => {
      return await new KnowledgeSourcesDAL().getKnowledgeSourceIds(tx, {
        companyId: tenantB.companyId,
        publicIds: [sourceA1.publicId, sourceB.publicId],
      });
    });
    expect("knowledgeSourceIds" in ids ? ids.knowledgeSourceIds : null).toEqual([sourceB.id]);
    expect(titlesOf(await search(tenantB, [sourceA1.publicId, sourceB.publicId]))).toEqual([
      "B refunds",
    ]);
  });
});

describe("Knowledge search ranking", () => {
  it("returns hits best first, cut to topK", async () => {
    const response = await search(
      tenantA,
      [sourceA1.publicId, sourceA2.publicId, pausedSource.publicId],
      {
        topK: 2,
      },
    );
    expect(response.hits).toHaveLength(2);
    expect(response.hits?.every((hit) => hit.score >= Constants.KNOWLEDGE_SEARCH_MIN_SCORE)).toBe(
      true,
    );
    expect(response.hits?.[0]).not.toHaveProperty("fusedScore");
  });

  it("drops candidates the reranker scores below the min score, so the model can say it doesn't know", async () => {
    const response = await search(tenantA, [sourceA1.publicId], { query: "warranty claims" });
    expect(response).toMatchObject({ isSuccess: true, hits: [] });
    // DEV_NOTE: The vector side still found candidates, so the reranker ran and judged them
    expect(mocks.rerank).toHaveBeenCalledTimes(1);
  });

  it("finds a chunk by its words alone, and one by its vector alone", async () => {
    const db = getDbClient(env);
    const dal = new KnowledgeChunksDAL();
    const side = {
      companyId: tenantA.companyId,
      knowledgeSourceIds: [sourceA1.id],
      embeddingModel: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
      limit: 10,
    };
    const sides = await withTenant(db, tenantA.companyId, async (tx) => {
      const vectorSide = await dal.searchKnowledgeChunksByVector(tx, {
        ...side,
        embedding: vector(2),
        efSearch: 100,
      });
      const keywordSide = await dal.searchKnowledgeChunksByKeyword(tx, {
        ...side,
        query: "shipping week",
      });
      return {
        isSuccess: true,
        vectorTexts: (vectorSide.matches ?? []).map((matchRow) => matchRow.text),
        keywordTexts: (keywordSide.matches ?? []).map((matchRow) => matchRow.text),
      };
    });
    if (!("vectorTexts" in sides)) throw new Error("Search failed");
    expect(sides.vectorTexts[0]).toBe("Shipping takes a week.");
    expect(sides.vectorTexts).toHaveLength(2);
    expect(sides.keywordTexts).toEqual(["Shipping takes a week."]);
  });
});

describe("Knowledge search model calls", () => {
  it("writes a platform-paid row per call, tied to the conversation and turn", async () => {
    const { ctx, settle } = testContext();
    const turnId = Utility.generateUlid();
    await new KnowledgeSearchRepo(env, ctx).search({
      companyId: tenantA.companyId,
      chatbotId: tenantA.chatbotId,
      chatbotUserId: tenantA.chatbotUserId,
      conversationId: tenantA.conversationId,
      turnId,
      sourcePublicIds: [sourceA1.publicId],
      topK: 5,
      query: "refund policy",
    });
    await settle();

    const rows = await withOwnerDb(async (ownerDb) => {
      const conditions = [
        eq(modelCalls.companyId, tenantA.companyId),
        eq(modelCalls.turnId, turnId),
      ];
      return await ownerDb
        .select()
        .from(modelCalls)
        .where(and(...conditions));
    });
    expect(rows.map((row) => [row.taskType, row.model]).sort()).toEqual([
      [Schemas.ModelTaskTypeEnum.SearchEmbed, Schemas.KNOWLEDGE_EMBEDDING_MODEL],
      [Schemas.ModelTaskTypeEnum.SearchRerank, Schemas.KNOWLEDGE_RERANK_MODEL],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        chatbotId: tenantA.chatbotId,
        chatbotUserId: tenantA.chatbotUserId,
        conversationId: tenantA.conversationId,
        tier: Schemas.ModelCallTierIntEnum.Embed,
        provider: Schemas.PlatformModelProviderEnum.WorkersAi,
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Estimated,
        outputTokens: null,
      });
      expect(Number(row.costUsd)).toBeGreaterThan(0);
    }
  });

  it("answers unavailable when a call fails, and still records the call", async () => {
    mocks.embed.mockResolvedValueOnce({
      isSuccess: false,
      message: "busy",
      calls: [{ inputTokens: 15, latencyMs: 5, gatewayLogId: null, errorCode: "embed_failed" }],
    });
    const { ctx, settle } = testContext();
    const embedFailed = await search(tenantA, [sourceA1.publicId], { ctx });
    expect(embedFailed.isSuccess).toBe(false);
    expect(mocks.rerank).not.toHaveBeenCalled();

    mocks.rerank.mockResolvedValueOnce({
      isSuccess: false,
      message: "busy",
      call: { inputTokens: 300, latencyMs: 7, gatewayLogId: null, errorCode: "rerank_failed" },
    });
    const rerankFailed = await search(tenantA, [sourceA1.publicId], { ctx });
    expect(rerankFailed.isSuccess).toBe(false);
    await settle();

    const failedRows = await withOwnerDb(async (ownerDb) => {
      const conditions = [
        eq(modelCalls.companyId, tenantA.companyId),
        inArray(modelCalls.errorCode, ["embed_failed", "rerank_failed"]),
      ];
      return await ownerDb
        .select({ errorCode: modelCalls.errorCode, costUsd: modelCalls.costUsd })
        .from(modelCalls)
        .where(and(...conditions));
    });
    expect(failedRows.map((row) => row.errorCode).sort()).toEqual([
      "embed_failed",
      "rerank_failed",
    ]);
    expect(failedRows.every((row) => Number(row.costUsd) > 0)).toBe(true);
  });

  it("keeps search calls out of the company budget", async () => {
    const { ctx, settle } = testContext();
    await search(tenantB, [sourceB.publicId], { ctx });
    await settle();
    const spent = await withTenant(getDbClient(env), tenantB.companyId, async (tx) => {
      return await new ModelCallsDAL().getModelCallCostSum(tx, {
        companyId: tenantB.companyId,
        from: new Date(Date.now() - 60 * 60_000),
      });
    });
    expect(spent).toMatchObject({ isSuccess: true, totalCostUsd: "0.000000" });
  });
});

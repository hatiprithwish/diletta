import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  companies,
  docGapClusters,
  docGaps,
  eventOutbox,
  files,
  knowledgeDocuments,
  knowledgeSources,
} from "@/db/tables";
import worker from "@/index";
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

// DEV_NOTE: Clerk stand-in. "Authorization: Bearer <clerkUserId>" signs in as that Clerk user; no header is
// signed out. Nobody here has invite metadata, so /dashboard/me never provisions.
vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: () => ({
      authenticateRequest: async (request: Request) => {
        const userId = request.headers.get("Authorization")?.replace("Bearer ", "");
        if (!userId) {
          return { isSignedIn: false, reason: "session-token-missing" };
        }
        return {
          isSignedIn: true,
          toAuth: () => ({ userId, sessionId: `sess_${userId}`, sessionClaims: {} }),
        };
      },
    }),
    getAdminProfile: async () => ({
      isSuccess: true,
      profile: { email: null, name: null, companyPublicId: null },
    }),
    consumeInvite: async () => ({ isSuccess: true }),
  },
}));

// DEV_NOTE: A sync is recorded, never started: no workflow instance, no fetch, no Workers AI
vi.mock("@/providers/knowledgeSyncWorkflow", () => ({
  default: { start: vi.fn().mockResolvedValue({ isSuccess: true }) },
}));

// DEV_NOTE: M4-7 "Done when": a group of questions links to the document that closed it. Also the Knowledge page's
// reads (source names and document counts, the document picker's title search, the groups with their tab counts and
// newest questions), Answer and Dismiss (Open only, document in the company), and removing the answering document
// reopening its group. Tests hit the Neon staging branch through the whole worker (Repos as diletta_app, so RLS
// applies); fixtures and cleanup run as the owner. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const START = Date.now() - 3 * 60 * 60 * 1000;
const at = (minutes: number) => new Date(START + minutes * 60 * 1000);
const { Open, Answered, Dismissed } = Schemas.DocGapClusterStatusIntEnum;
const Tab = Schemas.DocGapClusterListTabEnum;
// DEV_NOTE: No DB foreign keys; these groups are read, never clustered, so no chatbot row is needed
const FAKE_CHATBOT_ID = "999999999";
const vector = () => Array.from({ length: 1024 }, () => 0.5);

let companyA = "";
let companyB = "";
// DEV_NOTE: Company A: an upload source (two documents, one titled with LIKE wildcards) and a help center (one page).
// Its groups: two Open ones (14 and 9 questions), a third Open one with 3 for the removal test, one Answered by the
// help center page and one Dismissed. Company B: one source, one document, one group.
let uploadSource = "";
let helpCenter = "";
let certificatesDoc = "";
let wildcardDoc = "";
let helpPageDoc = "";
let otherCompanyDoc = "";
let bigCluster = "";
let mediumCluster = "";
let smallCluster = "";
let answeredCluster = "";
let dismissedCluster = "";
let otherCompanyCluster = "";
const BIG_QUESTIONS = [
  "How do I upload a contractor's insurance certificate?",
  "Where do insurance certificates go?",
  "Can a contractor upload their own certificate?",
  "What file types work for certificates?",
];

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

// DEV_NOTE: The company's audit rows (M4-9) of one entity type, oldest first, read as the owner
async function auditEvents(companyId: string, entityType: string) {
  let rows: {
    actorType: number;
    entityAction: string;
    entityVersion: number | null;
    detail: unknown;
  }[] = [];
  await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, entityType),
    ];
    rows = await ownerDb
      .select({
        actorType: activityLog.actorType,
        entityAction: activityLog.entityAction,
        entityVersion: activityLog.entityVersion,
        detail: activityLog.detail,
      })
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  });
  return rows;
}

async function call<T>(
  method: string,
  path: string,
  options: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: T & Schemas.ApiResponse }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as T & Schemas.ApiResponse };
}

const clusters = (query = "", as = adminA) =>
  call<Schemas.GetDocGapClustersApiResponse>(
    "GET",
    `/dashboard/doc-gap-clusters${query ? `?${query}` : ""}`,
    { as },
  );

const answer = (publicId: string, documentPublicId: string, as = adminA) =>
  call<Schemas.UpdateDocGapClusterApiResponse>(
    "POST",
    `/dashboard/doc-gap-clusters/${publicId}/answer`,
    { as, body: { documentPublicId } },
  );

const dismiss = (publicId: string, as = adminA) =>
  call<Schemas.UpdateDocGapClusterApiResponse>(
    "POST",
    `/dashboard/doc-gap-clusters/${publicId}/dismiss`,
    { as },
  );

async function clusterRow(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({
        status: docGapClusters.status,
        answeredByDocumentId: docGapClusters.answeredByDocumentId,
      })
      .from(docGapClusters)
      .where(eq(docGapClusters.publicId, publicId));
    return row;
  });
}

// DEV_NOTE: A document with its file row, as an upload or a sync leaves it
async function createDocument(
  ownerDb: NodePgDatabase,
  params: { companyId: string; knowledgeSourceId: string; title: string; sourceUrl: string | null },
) {
  const [file] = await ownerDb
    .insert(files)
    .values({
      publicId: Utility.generatePublicId(),
      companyId: params.companyId,
      ownerType: Schemas.FileOwnerTypeEnum.KnowledgeDocument,
      ownerId: "0",
      filename: params.title,
      mime: "application/pdf",
      sizeBytes: 10,
      sha256: "0".repeat(64),
    })
    .returning({ id: files.id });
  const [document] = await ownerDb
    .insert(knowledgeDocuments)
    .values({
      publicId: Utility.generatePublicId(),
      companyId: params.companyId,
      knowledgeSourceId: params.knowledgeSourceId,
      fileId: file!.id,
      title: params.title,
      sourceUrl: params.sourceUrl,
      indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
    })
    .returning({ id: knowledgeDocuments.id, publicId: knowledgeDocuments.publicId });
  await ownerDb.update(files).set({ ownerId: document!.id }).where(eq(files.id, file!.id));
  return document!;
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
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA },
      { clerkUserId: adminB, companyId: companyB },
    ]);

    const sources = await ownerDb
      .insert(knowledgeSources)
      .values([
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          name: "Uploaded procedures",
          type: Schemas.KnowledgeSourceTypeIntEnum.Upload,
          createdAt: at(0),
        },
        {
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          name: "Help center",
          type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap,
          url: "https://help.example.com/sitemap.xml",
          syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
          status: Schemas.KnowledgeSourceStatusIntEnum.Failed,
          createdAt: at(1),
        },
        {
          publicId: Utility.generatePublicId(),
          companyId: companyB,
          name: "Other uploads",
          type: Schemas.KnowledgeSourceTypeIntEnum.Upload,
        },
      ])
      .returning({ id: knowledgeSources.id, publicId: knowledgeSources.publicId });
    const [upload, help, other] = sources;
    uploadSource = upload!.publicId;
    helpCenter = help!.publicId;

    const certificates = await createDocument(ownerDb, {
      companyId: companyA,
      knowledgeSourceId: upload!.id,
      title: "Insurance certificates.pdf",
      sourceUrl: null,
    });
    const wildcard = await createDocument(ownerDb, {
      companyId: companyA,
      knowledgeSourceId: upload!.id,
      title: "Fire_drills 100%.pdf",
      sourceUrl: null,
    });
    const helpPage = await createDocument(ownerDb, {
      companyId: companyA,
      knowledgeSourceId: help!.id,
      title: "Archiving a register",
      sourceUrl: "https://help.example.com/archiving",
    });
    const otherDocument = await createDocument(ownerDb, {
      companyId: companyB,
      knowledgeSourceId: other!.id,
      title: "Other company doc",
      sourceUrl: null,
    });
    certificatesDoc = certificates.publicId;
    wildcardDoc = wildcard.publicId;
    helpPageDoc = helpPage.publicId;
    otherCompanyDoc = otherDocument.publicId;

    const cluster = (
      companyId: string,
      label: string,
      questionCount: number,
      status = Open,
      answeredByDocumentId: string | null = null,
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotId: FAKE_CHATBOT_ID,
      label,
      centroid: vector(),
      questionCount,
      status,
      answeredByDocumentId,
    });
    const groups = await ownerDb
      .insert(docGapClusters)
      .values([
        cluster(companyA, "Changing an inspection checklist template", 9),
        cluster(companyA, "Uploading contractor insurance certificates", 14),
        cluster(companyA, "Fire drill frequency", 3),
        cluster(companyA, "Archiving a whole register", 6, Answered, helpPage.id),
        cluster(companyA, "Printing labels", 2, Dismissed),
        cluster(companyB, "Other company group", 5),
      ])
      .returning({ id: docGapClusters.id, publicId: docGapClusters.publicId });
    mediumCluster = groups[0]!.publicId;
    bigCluster = groups[1]!.publicId;
    smallCluster = groups[2]!.publicId;
    answeredCluster = groups[3]!.publicId;
    dismissedCluster = groups[4]!.publicId;
    otherCompanyCluster = groups[5]!.publicId;

    await ownerDb.insert(docGaps).values([
      ...BIG_QUESTIONS.map((questionGeneric, index) => ({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        chatbotId: FAKE_CHATBOT_ID,
        questionGeneric,
        signal: Schemas.DocGapSignalIntEnum.Idk,
        clusterId: groups[1]!.id,
        createdAt: at(10 + index),
      })),
      {
        publicId: Utility.generatePublicId(),
        companyId: companyB,
        chatbotId: FAKE_CHATBOT_ID,
        questionGeneric: "Other company question?",
        signal: Schemas.DocGapSignalIntEnum.LowRetrieval,
        clusterId: groups[5]!.id,
        createdAt: at(30),
      },
    ]);
  });
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
    const companyIds = [companyA, companyB].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(docGaps).where(inArray(docGaps.companyId, companyIds));
    await ownerDb.delete(docGapClusters).where(inArray(docGapClusters.companyId, companyIds));
    await ownerDb
      .delete(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.companyId, companyIds));
    await ownerDb.delete(files).where(inArray(files.companyId, companyIds));
    await ownerDb.delete(knowledgeSources).where(inArray(knowledgeSources.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("Knowledge page sources", () => {
  it("lists each source with its name and document count", async () => {
    const listed = await call<Schemas.GetKnowledgeSourcesApiResponse>(
      "GET",
      "/dashboard/knowledge-sources",
      { as: adminA },
    );
    expect(listed.status).toBe(200);
    expect(
      listed.body.knowledgeSources?.map((source) => [
        source.publicId,
        source.name,
        source.documentCount,
      ]),
    ).toEqual([
      [helpCenter, "Help center", 1],
      [uploadSource, "Uploaded procedures", 2],
    ]);
  });

  it("lists only the sources in one state when asked (the failed-sync banners)", async () => {
    const failed = await call<Schemas.GetKnowledgeSourcesApiResponse>(
      "GET",
      `/dashboard/knowledge-sources?status=${Schemas.KnowledgeSourceStatusIntEnum.Failed}`,
      { as: adminA },
    );
    expect(failed.status).toBe(200);
    expect(failed.body.knowledgeSources?.map((source) => source.publicId)).toEqual([helpCenter]);
    expect(
      (await call("GET", "/dashboard/knowledge-sources?status=9", { as: adminA })).status,
    ).toBe(400);
  });

  it("needs a name to create a source, and renames one", async () => {
    const unnamed = await call("POST", "/dashboard/knowledge-sources", {
      as: adminA,
      body: { knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Upload } },
    });
    expect(unnamed.status).toBe(400);
    const blank = await call("POST", "/dashboard/knowledge-sources", {
      as: adminA,
      body: { knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Upload, name: "  " } },
    });
    expect(blank.status).toBe(400);
    // DEV_NOTE: An address that isn't a URL at all is a 400, never a 500 (the port check doesn't parse it)
    const unparseable = await call("POST", "/dashboard/knowledge-sources", {
      as: adminA,
      body: {
        knowledgeSource: {
          type: Schemas.KnowledgeSourceTypeIntEnum.Url,
          name: "Broken",
          url: "http://",
          syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
        },
      },
    });
    expect(unparseable.status).toBe(400);

    const renamed = await call<Schemas.UpdateKnowledgeSourceApiResponse>(
      "PATCH",
      `/dashboard/knowledge-sources/${helpCenter}`,
      { as: adminA, body: { knowledgeSource: { name: "  Help centre " } } },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.body.knowledgeSource?.name).toBe("Help centre");
    expect(renamed.body.knowledgeSource?.syncFrequency).toBe(
      Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
    );
  });

  it("finds a source's documents by title, taking wildcards literally", async () => {
    const search = async (text: string) => {
      const query = new URLSearchParams({ search: text }).toString();
      const base = `/dashboard/knowledge-sources/${uploadSource}/documents`;
      const page = await call<Schemas.GetKnowledgeDocumentsApiResponse>("GET", `${base}?${query}`, {
        as: adminA,
      });
      const counted = await call<Schemas.GetKnowledgeDocumentsCountApiResponse>(
        "GET",
        `${base}/count?${query}`,
        { as: adminA },
      );
      expect(page.status).toBe(200);
      expect(counted.body.totalRecords).toBe(page.body.knowledgeDocuments?.length);
      return page.body.knowledgeDocuments?.map((document) => document.publicId);
    };
    expect(await search("INSURANCE")).toEqual([certificatesDoc]);
    expect(await search("_")).toEqual([wildcardDoc]);
    expect(await search("100%")).toEqual([wildcardDoc]);
    expect(await search("  ")).toHaveLength(2);
  });
});

describe("/dashboard/doc-gap-clusters", () => {
  it("answers 401 signed out and 403 to an operator", async () => {
    expect((await call("GET", "/dashboard/doc-gap-clusters")).status).toBe(401);
    expect((await clusters("", operator)).status).toBe(403);
    expect((await dismiss(bigCluster, operator)).status).toBe(403);
  });

  it("lists Open groups most-asked first, with every tab's count and the newest questions", async () => {
    const listed = await clusters();
    expect(listed.status).toBe(200);
    expect(listed.body.tabCounts).toEqual({ [Tab.Open]: 3, [Tab.Answered]: 1, [Tab.Dismissed]: 1 });
    expect(listed.body.totalRecords).toBe(3);
    const rows = listed.body.docGapClusters ?? [];
    expect(rows.map((row) => row.publicId)).toEqual([bigCluster, mediumCluster, smallCluster]);

    const [big] = rows;
    expect(big).toMatchObject({
      label: "Uploading contractor insurance certificates",
      questionCount: 14,
      docGapClusterStatus: Open,
      docGapClusterStatusLabel: Schemas.DocGapClusterStatusLabelEnum.Open,
      latestQuestionAt: at(13).toISOString(),
      answeredBy: null,
    });
    expect(big!.sampleQuestions).toEqual([...BIG_QUESTIONS].reverse().slice(0, 3));
    expect(rows[1]!.sampleQuestions).toEqual([]);
    expect(rows[1]!.latestQuestionAt).toBeNull();
    expect(JSON.stringify(listed.body)).not.toMatch(/"(id|companyId|answeredByDocumentId)"/);
  });

  it("links an Answered group to the document that closed it", async () => {
    const listed = await clusters(`tab=${Tab.Answered}`);
    expect(listed.body.docGapClusters?.map((row) => row.publicId)).toEqual([answeredCluster]);
    expect(listed.body.docGapClusters?.[0]?.answeredBy).toEqual({
      documentPublicId: helpPageDoc,
      title: "Archiving a register",
      sourceUrl: "https://help.example.com/archiving",
      knowledgeSource: { publicId: helpCenter, name: "Help centre" },
    });
    const dismissed = await clusters(`tab=${Tab.Dismissed}`);
    expect(dismissed.body.docGapClusters?.map((row) => row.publicId)).toEqual([dismissedCluster]);
  });

  it("shows another company only its own (RLS, diletta_app)", async () => {
    const listed = await clusters("", adminB);
    expect(listed.body.docGapClusters?.map((row) => row.publicId)).toEqual([otherCompanyCluster]);
    expect(listed.body.docGapClusters?.[0]?.sampleQuestions).toEqual(["Other company question?"]);
    expect((await answer(bigCluster, certificatesDoc, adminB)).status).toBe(404);
    expect((await dismiss(bigCluster, adminB)).status).toBe(404);
    expect((await clusterRow(bigCluster))?.status).toBe(Open);
  });

  it("answers an Open group with a document of the company, once", async () => {
    expect((await answer(mediumCluster, otherCompanyDoc)).status).toBe(404);
    expect((await answer(mediumCluster, "missing")).status).toBe(404);
    expect((await answer("missing", certificatesDoc)).status).toBe(404);
    expect((await clusterRow(mediumCluster))?.status).toBe(Open);

    const answered = await answer(mediumCluster, certificatesDoc);
    expect(answered.status).toBe(200);
    expect(answered.body.docGapCluster).toMatchObject({
      publicId: mediumCluster,
      docGapClusterStatus: Answered,
      answeredBy: {
        documentPublicId: certificatesDoc,
        title: "Insurance certificates.pdf",
        sourceUrl: null,
        knowledgeSource: { publicId: uploadSource, name: "Uploaded procedures" },
      },
    });

    const again = await answer(mediumCluster, wildcardDoc);
    expect(again.status).toBe(409);
    expect(again.body.failure).toBe(Schemas.DocGapClusterUpdateFailureEnum.NotOpen);
    expect((await dismiss(mediumCluster)).status).toBe(409);
    expect((await dismiss(answeredCluster)).status).toBe(409);

    // DEV_NOTE: One audit row for the answer (M4-9), none for the refusals
    const events = await auditEvents(companyA, Schemas.AuditEntityTypeEnum.DocGapCluster);
    expect(events.map((event) => [event.actorType, event.entityAction])).toEqual([
      [Schemas.ActivityLogActorTypeIntEnum.Admin, Schemas.AuditEntityActionEnum.Answered],
    ]);
  });

  it("dismisses an Open group, once", async () => {
    const dismissed = await dismiss(bigCluster);
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.docGapCluster?.docGapClusterStatus).toBe(Dismissed);
    expect(dismissed.body.docGapCluster?.sampleQuestions.length).toBe(3);
    expect((await dismiss(bigCluster)).status).toBe(409);
    expect((await answer(bigCluster, certificatesDoc)).status).toBe(409);
    expect((await clusterRow(bigCluster))?.answeredByDocumentId).toBeNull();
    expect(
      (await auditEvents(companyA, Schemas.AuditEntityTypeEnum.DocGapCluster)).map(
        (event) => event.entityAction,
      ),
    ).toEqual([Schemas.AuditEntityActionEnum.Answered, Schemas.AuditEntityActionEnum.Dismissed]);
  });

  it("reopens a group when the document that answered it is removed", async () => {
    expect((await answer(smallCluster, wildcardDoc)).status).toBe(200);
    const removed = await call(
      "DELETE",
      `/dashboard/knowledge-sources/${uploadSource}/documents/${wildcardDoc}`,
      { as: adminA },
    );
    expect(removed.status).toBe(200);
    expect(await clusterRow(smallCluster)).toEqual({ status: Open, answeredByDocumentId: null });
    // DEV_NOTE: Another document's group stays as it is
    expect((await clusterRow(mediumCluster))?.status).toBe(Answered);
  });

  // DEV_NOTE: Two connections. A delete of the document is under way (not committed) when Answer runs: Answer must wait
  // for it (FOR KEY SHARE on the document) and then find nothing, never commit a group pointing at a deleted document
  it("waits for a delete of the document under way, then answers 404", async () => {
    const { clusterPublicId, documentId, documentPublicId } = await withOwnerDb(async (ownerDb) => {
      const [upload] = await ownerDb
        .select({ id: knowledgeSources.id })
        .from(knowledgeSources)
        .where(eq(knowledgeSources.publicId, uploadSource));
      const document = await createDocument(ownerDb, {
        companyId: companyA,
        knowledgeSourceId: upload!.id,
        title: "Race document.pdf",
        sourceUrl: null,
      });
      const [group] = await ownerDb
        .insert(docGapClusters)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: companyA,
          chatbotId: FAKE_CHATBOT_ID,
          label: "Race group",
          centroid: vector(),
          questionCount: 1,
        })
        .returning({ publicId: docGapClusters.publicId });
      return {
        clusterPublicId: group!.publicId,
        documentId: document.id,
        documentPublicId: document.publicId,
      };
    });

    const deleter = new Client({ connectionString: ownerDatabaseUrl });
    const observer = new Client({ connectionString: ownerDatabaseUrl });
    await deleter.connect();
    await observer.connect();
    try {
      await deleter.query("BEGIN");
      const deleterPid = (
        (await deleter.query("SELECT pg_backend_pid() AS pid")).rows[0] as {
          pid: number;
        }
      ).pid;
      await deleter.query("DELETE FROM knowledge_documents WHERE id = $1", [documentId]);
      const answered = answer(clusterPublicId, documentPublicId);
      // DEV_NOTE: Answer must end up blocked by the uncommitted delete (its FOR KEY SHARE read). Without the lock it
      // would read the still-committed document, answer the group and never wait.
      let isBlocked = false;
      for (let attempt = 0; attempt < 100 && !isBlocked; attempt++) {
        const blocked = await observer.query(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
          [deleterPid],
        );
        isBlocked = (blocked.rows[0] as { count: number }).count > 0;
        if (!isBlocked) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(isBlocked).toBe(true);
      await deleter.query("COMMIT");
      expect((await answered).status).toBe(404);
    } finally {
      await deleter.query("ROLLBACK").catch(() => undefined);
      await deleter.end();
      await observer.end();
    }
    expect(await clusterRow(clusterPublicId)).toEqual({ status: Open, answeredByDocumentId: null });
  });

  it("reopens the groups of every document of a deleted source", async () => {
    const deleted = await call("DELETE", `/dashboard/knowledge-sources/${helpCenter}`, {
      as: adminA,
    });
    expect(deleted.status).toBe(200);
    expect(await clusterRow(answeredCluster)).toEqual({
      status: Open,
      answeredByDocumentId: null,
    });
  });
});

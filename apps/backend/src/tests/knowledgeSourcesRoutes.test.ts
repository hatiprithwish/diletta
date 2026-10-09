import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { admins, companies, files, knowledgeDocuments, knowledgeSources } from "@/db/tables";
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

// DEV_NOTE: Tests hit the Neon staging branch through the whole worker (middleware → Repo as diletta_app).
// Fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const stranger = `user_x_${crypto.randomUUID()}`;
let companyA = "";
let companyB = "";

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function call(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; form?: FormData } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (!options.form) headers["Content-Type"] = "application/json";
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: await response.json() };
}

function upload(name: string, content: string, type: string) {
  const form = new FormData();
  form.append("file", new File([content], name, { type }));
  return form;
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Knowledge routes A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Knowledge routes B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA },
      { clerkUserId: adminB, companyId: companyB },
    ]);
  });
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
    const companyIds = [companyA, companyB].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb
      .delete(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.companyId, companyIds));
    await ownerDb.delete(files).where(inArray(files.companyId, companyIds));
    await ownerDb.delete(knowledgeSources).where(inArray(knowledgeSources.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("/dashboard/knowledge-sources", () => {
  it("answers 401 signed out and 403 to a stranger or an operator", async () => {
    expect((await call("GET", "/dashboard/knowledge-sources")).status).toBe(401);
    expect((await call("GET", "/dashboard/knowledge-sources", { as: stranger })).status).toBe(403);
    expect((await call("GET", "/dashboard/knowledge-sources", { as: operator })).status).toBe(403);
    const created = await call("POST", "/dashboard/knowledge-sources", {
      as: operator,
      body: { knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Upload } },
    });
    expect(created.status).toBe(403);
  });

  it("refuses a URL that isn't a public http(s) domain with 400", async () => {
    for (const url of ["http://127.0.0.1/sitemap.xml", "http://localhost/x", "ftp://docs.test/x"]) {
      const response = await call("POST", "/dashboard/knowledge-sources", {
        as: adminA,
        body: {
          knowledgeSource: {
            type: Schemas.KnowledgeSourceTypeIntEnum.Url,
            url,
            syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
          },
        },
      });
      expect(response.status).toBe(400);
    }
    const missingUrl = await call("POST", "/dashboard/knowledge-sources", {
      as: adminA,
      body: { knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap } },
    });
    expect(missingUrl.status).toBe(400);
  });

  it(
    "creates, lists, reads, uploads to, syncs, updates and deletes a source",
    { timeout: 120_000 },
    async () => {
      const created = await call("POST", "/dashboard/knowledge-sources", {
        as: adminA,
        body: { knowledgeSource: { type: Schemas.KnowledgeSourceTypeIntEnum.Upload } },
      });
      expect(created.status).toBe(201);
      const source = created.body.knowledgeSource as Schemas.KnowledgeSourceWithStatus;
      expect(source.typeLabel).toBe(Schemas.KnowledgeSourceTypeLabelEnum.Upload);
      expect(source.knowledgeSourceStatusLabel).toBe(Schemas.KnowledgeSourceStatusLabelEnum.Active);
      expect(source).not.toHaveProperty("id");
      expect(source).not.toHaveProperty("companyId");
      const base = `/dashboard/knowledge-sources/${source.publicId}`;

      const listed = await call("GET", "/dashboard/knowledge-sources?pageSize=5", { as: adminA });
      expect(listed.status).toBe(200);
      expect(
        (listed.body.knowledgeSources as Schemas.KnowledgeSourceWithStatus[]).map(
          (row) => row.publicId,
        ),
      ).toContain(source.publicId);
      const counted = await call("GET", "/dashboard/knowledge-sources/count", { as: adminA });
      expect(counted.body.totalRecords).toBe(1);
      expect((await call("GET", base, { as: adminA })).status).toBe(200);
      expect(
        (
          await call("GET", `/dashboard/knowledge-sources/${Utility.generatePublicId()}`, {
            as: adminA,
          })
        ).status,
      ).toBe(404);
      expect((await call("GET", base, { as: adminB })).status).toBe(404);

      const unsupported = await call("POST", `${base}/documents`, {
        as: adminA,
        form: upload("photo.png", "png", "image/png"),
      });
      expect(unsupported.status).toBe(400);
      const uploaded = await call("POST", `${base}/documents`, {
        as: adminA,
        form: upload("guide.md", "# Guide\n\nHello.", ""),
      });
      expect(uploaded.status).toBe(201);
      const document = uploaded.body.knowledgeDocument as Schemas.KnowledgeDocumentWithStatus;
      expect(document.knowledgeDocumentIndexStatusLabel).toBe(
        Schemas.KnowledgeDocumentIndexStatusLabelEnum.Pending,
      );
      expect(document).not.toHaveProperty("fileId");

      const documents = await call("GET", `${base}/documents`, { as: adminA });
      expect(documents.status).toBe(200);
      expect((await call("GET", `${base}/documents/count`, { as: adminA })).body.totalRecords).toBe(
        1,
      );

      // DEV_NOTE: The upload started a sync, so a second one is refused while it runs
      const again = await call("POST", `${base}/sync`, { as: adminA });
      expect(again.status).toBe(409);
      expect(again.body.failure).toBe(Schemas.KnowledgeSourceFailureEnum.AlreadySyncing);

      const frequency = await call("PATCH", base, {
        as: adminA,
        body: {
          knowledgeSource: { syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily },
        },
      });
      expect(frequency.status).toBe(409);
      expect(
        (await call("PATCH", base, { as: adminA, body: { knowledgeSource: {} } })).status,
      ).toBe(400);
      const paused = await call("PATCH", base, {
        as: adminA,
        body: { knowledgeSource: { status: Schemas.KnowledgeSourceStatusIntEnum.Paused } },
      });
      expect(paused.status).toBe(200);
      expect((await call("POST", `${base}/sync`, { as: adminA })).status).toBe(409);

      const removedDocument = await call("DELETE", `${base}/documents/${document.publicId}`, {
        as: adminA,
      });
      expect(removedDocument.status).toBe(200);
      expect(
        (await call("DELETE", `${base}/documents/${document.publicId}`, { as: adminA })).status,
      ).toBe(404);

      expect((await call("DELETE", base, { as: adminB })).status).toBe(404);
      expect((await call("DELETE", base, { as: adminA })).status).toBe(200);
      expect((await call("DELETE", base, { as: adminA })).status).toBe(404);
    },
  );

  it("refuses an upload to a web source with 409", async () => {
    const created = await call("POST", "/dashboard/knowledge-sources", {
      as: adminA,
      body: {
        knowledgeSource: {
          type: Schemas.KnowledgeSourceTypeIntEnum.Url,
          url: "https://docs.example.com/faq",
          syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Manual,
        },
      },
    });
    expect(created.status).toBe(201);
    const source = created.body.knowledgeSource as Schemas.KnowledgeSourceWithStatus;
    expect(source.knowledgeSourceStatusLabel).toBe(Schemas.KnowledgeSourceStatusLabelEnum.Syncing);
    const uploaded = await call(
      "POST",
      `/dashboard/knowledge-sources/${source.publicId}/documents`,
      {
        as: adminA,
        form: upload("a.txt", "text", "text/plain"),
      },
    );
    expect(uploaded.status).toBe(409);
    expect(uploaded.body.failure).toBe(Schemas.KnowledgeSourceFailureEnum.NotUploadSource);
  });
});

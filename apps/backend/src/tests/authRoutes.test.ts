import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { admins, chatbots, companies, companyEncryptionKeys } from "@/db/tables";
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
// signed out. Every Clerk user here has no invite metadata, so /dashboard/me never provisions in this suite.
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
  },
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
let chatbotOfB = "";
const createdCompanyPublicIds: string[] = [];

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
  options: { as?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) {
    headers["Authorization"] = `Bearer ${options.as}`;
  }
  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Auth company A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Auth company B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;

    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA },
      { clerkUserId: adminB, companyId: companyB },
    ]);

    const [chatbot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId: companyB, name: "B's bot" })
      .returning({ publicId: chatbots.publicId });
    chatbotOfB = chatbot!.publicId;
  });
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));

    const companyIds = [companyA, companyB].filter(Boolean);
    const publicIds = createdCompanyPublicIds.filter(Boolean);
    if (publicIds.length > 0) {
      const createdByOperator = await ownerDb
        .select({ id: companies.id })
        .from(companies)
        .where(inArray(companies.publicId, publicIds));
      companyIds.push(...createdByOperator.map((row) => row.id));
    }
    if (companyIds.length === 0) return;

    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb
      .delete(companyEncryptionKeys)
      .where(inArray(companyEncryptionKeys.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("authentication", () => {
  it("answers 401 to a signed-out request", async () => {
    expect((await call("GET", "/dashboard/me")).status).toBe(401);
    expect((await call("GET", "/dashboard/chatbots")).status).toBe(401);
    expect((await call("GET", "/operator/companies")).status).toBe(401);
  });
});

describe("GET /dashboard/me", () => {
  it("answers 403 to a Clerk user who is not an admin and wasn't invited", async () => {
    const { status, body } = await call("GET", "/dashboard/me", { as: stranger });
    expect(status).toBe(403);
    expect(body.admin).toBeUndefined();
  });

  it("returns the company admin without internal ids", async () => {
    const { status, body } = await call("GET", "/dashboard/me", { as: adminA });
    expect(status).toBe(200);
    const admin = body.admin as Schemas.AdminProfile;
    expect(admin.role).toBe(Schemas.AdminRoleEnum.CompanyAdmin);
    expect(admin.company?.publicId).toBeTruthy();
    expect(admin).not.toHaveProperty("id");
    expect(admin).not.toHaveProperty("companyId");
  });

  it("returns the operator with no company", async () => {
    const { status, body } = await call("GET", "/dashboard/me", { as: operator });
    expect(status).toBe(200);
    expect((body.admin as Schemas.AdminProfile).role).toBe(Schemas.AdminRoleEnum.Operator);
  });
});

describe("dashboard routes (company admin)", () => {
  it("answers 403 to a signed-in Clerk user with no admins row", async () => {
    expect((await call("GET", "/dashboard/chatbots", { as: stranger })).status).toBe(403);
    expect((await call("GET", `/dashboard/chatbots/${chatbotOfB}`, { as: stranger })).status).toBe(
      403,
    );
    const created = await call("POST", "/dashboard/chatbots", {
      as: stranger,
      body: { chatbot: { name: "Nope" } },
    });
    expect(created.status).toBe(403);
  });

  it("answers 403 to an operator: company routes need a company", async () => {
    expect((await call("GET", "/dashboard/chatbots", { as: operator })).status).toBe(403);
    const created = await call("POST", "/dashboard/chatbots", {
      as: operator,
      body: { chatbot: { name: "Nope" } },
    });
    expect(created.status).toBe(403);
  });

  it("lets a company admin create, list, read and update their own chatbots", async () => {
    const created = await call("POST", "/dashboard/chatbots", {
      as: adminA,
      body: { chatbot: { name: "A's bot" } },
    });
    expect(created.status).toBe(201);
    const chatbot = created.body.chatbot as Schemas.ChatbotWithStatus;
    expect(chatbot).not.toHaveProperty("id");
    expect(chatbot).not.toHaveProperty("companyId");

    const listed = await call("GET", "/dashboard/chatbots", { as: adminA });
    expect(listed.status).toBe(200);
    const publicIds = (listed.body.chatbots as Schemas.ChatbotWithStatus[]).map(
      (row) => row.publicId,
    );
    expect(publicIds).toContain(chatbot.publicId);
    expect(publicIds).not.toContain(chatbotOfB);

    const fetched = await call("GET", `/dashboard/chatbots/${chatbot.publicId}`, { as: adminA });
    expect(fetched.status).toBe(200);

    const updated = await call("PATCH", `/dashboard/chatbots/${chatbot.publicId}`, {
      as: adminA,
      body: { chatbot: { name: "A's renamed bot" } },
    });
    expect(updated.status).toBe(200);
    expect((updated.body.chatbot as Schemas.ChatbotWithStatus).name).toBe("A's renamed bot");
  });

  it("never reads or writes another company's chatbot", async () => {
    expect((await call("GET", `/dashboard/chatbots/${chatbotOfB}`, { as: adminA })).status).toBe(
      404,
    );
    const updated = await call("PATCH", `/dashboard/chatbots/${chatbotOfB}`, {
      as: adminA,
      body: { chatbot: { name: "Hijacked" } },
    });
    expect(updated.status).toBe(404);

    const untouched = await call("GET", `/dashboard/chatbots/${chatbotOfB}`, { as: adminB });
    expect(untouched.status).toBe(200);
    expect((untouched.body.chatbot as Schemas.ChatbotWithStatus).name).toBe("B's bot");
  });

  it("validates the body only after authorizing", async () => {
    const forbidden = await call("POST", "/dashboard/chatbots", {
      as: stranger,
      body: { chatbot: { name: "" } },
    });
    expect(forbidden.status).toBe(403);

    const invalid = await call("POST", "/dashboard/chatbots", {
      as: adminA,
      body: { chatbot: { name: "" } },
    });
    expect(invalid.status).toBe(400);
  });
});

describe("operator routes", () => {
  it("answers 403 to a company admin", async () => {
    expect((await call("GET", "/operator/companies", { as: adminA })).status).toBe(403);
    expect((await call("GET", "/operator/companies/count", { as: adminA })).status).toBe(403);
    const created = await call("POST", "/operator/companies", {
      as: adminA,
      body: { company: { name: "Nope" } },
    });
    expect(created.status).toBe(403);
  });

  it("answers 403 to a signed-in Clerk user with no admins row", async () => {
    expect((await call("GET", "/operator/companies", { as: stranger })).status).toBe(403);
    const created = await call("POST", "/operator/companies", {
      as: stranger,
      body: { company: { name: "Nope" } },
    });
    expect(created.status).toBe(403);
  });

  it("lets an operator create, list and count companies", async () => {
    const created = await call("POST", "/operator/companies", {
      as: operator,
      body: { company: { name: `Operator-made ${crypto.randomUUID()}` } },
    });
    expect(created.status).toBe(201);
    const company = created.body.company as Schemas.CompanyWithStatus;
    createdCompanyPublicIds.push(company.publicId);
    expect(company).not.toHaveProperty("id");

    const listed = await call("GET", "/operator/companies?pageNo=1&pageSize=5&sortDirection=desc", {
      as: operator,
    });
    expect(listed.status).toBe(200);
    expect((listed.body.companies as Schemas.CompanyWithStatus[]).length).toBeLessThanOrEqual(5);

    const counted = await call("GET", "/operator/companies/count", { as: operator });
    expect(counted.status).toBe(200);
    expect(counted.body.totalRecords).toBeGreaterThan(0);
  });

  it("rejects a page size over the limit", async () => {
    const listed = await call("GET", `/operator/companies?pageSize=${Schemas.MAX_PAGE_SIZE + 1}`, {
      as: operator,
    });
    expect(listed.status).toBe(400);
  });
});

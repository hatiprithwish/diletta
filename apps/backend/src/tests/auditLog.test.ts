import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { activityLog, admins, chatbots, companies, eventOutbox } from "@/db/tables";
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

// DEV_NOTE: The audit log (M4-9) through the whole worker: admin writes record their rows (chatbots here; every other
// Repo's writes are checked in its own suite), and GET /dashboard/audit-log reads back only the company's admin and
// operator rows, as diletta_app. Fixtures (an operator's row, a chatbot user's and the system's) and cleanup run as the
// owner on the Neon staging branch.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
let companyA = "";
let companyB = "";
let operatorId = "";

type AuditBody = Schemas.GetAuditLogApiResponse & Schemas.ExportAuditLogApiResponse;

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
): Promise<{ status: number; body: AuditBody & Record<string, unknown> }> {
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
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Audit A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Audit B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    const createdAdmins = await ownerDb
      .insert(admins)
      .values([
        { clerkUserId: operator, companyId: null, name: "Olive Operator" },
        { clerkUserId: adminA, companyId: companyA, name: "Ana Ruiz" },
        { clerkUserId: adminB, companyId: companyB, name: "Marcus Lee" },
      ])
      .returning({ id: admins.id });
    operatorId = createdAdmins[0]!.id;

    // DEV_NOTE: An operator's tool write an hour ago (its name is never read by a tenant), and rows the audit log
    // leaves out: a chatbot user's and the system's
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await ownerDb.insert(activityLog).values([
      {
        companyId: companyA,
        actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
        actorId: operatorId,
        entityType: Schemas.AuditEntityTypeEnum.ToolDefinition,
        entityId: "1",
        entityAction: Schemas.AuditEntityActionEnum.Activated,
        entityVersion: 2,
        detail: { label: "update_record" },
        createdAt: anHourAgo,
      },
      {
        companyId: companyA,
        actorType: Schemas.ActivityLogActorTypeIntEnum.ChatbotUser,
        actorId: "1",
        entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
        entityId: "1",
        entityAction: Schemas.ChangeRequestEntityActionEnum.Approved,
        detail: {},
        createdAt: anHourAgo,
      },
      {
        companyId: companyA,
        actorType: Schemas.ActivityLogActorTypeIntEnum.System,
        actorId: null,
        entityType: Schemas.CHANGE_REQUEST_ENTITY_TYPE,
        entityId: "1",
        entityAction: Schemas.ChangeRequestEntityActionEnum.Verified,
        detail: {},
        createdAt: anHourAgo,
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
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("audit log (M4-9)", { timeout: 60_000 }, () => {
  it("records each admin write and reads back the company's admin and operator rows, newest first", async () => {
    const created = await call("POST", "/dashboard/chatbots", {
      as: adminA,
      body: { chatbot: { name: "Support" } },
    });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty("outboxIds");
    const publicId = (created.body.chatbot as { publicId: string }).publicId;

    const renamed = await call("PATCH", `/dashboard/chatbots/${publicId}`, {
      as: adminA,
      body: { chatbot: { name: "Help desk", status: Schemas.ChatbotStatusIntEnum.Paused } },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).not.toHaveProperty("outboxIds");

    const listed = await call("GET", "/dashboard/audit-log", { as: adminA });
    expect(listed.status).toBe(200);
    const entries = listed.body.auditLog ?? [];
    expect(entries.map(({ createdAt: _createdAt, ...entry }) => entry)).toEqual([
      // DEV_NOTE: The rename and the pause share a transaction, so a time; ties read in insert order
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        actorTypeLabel: Schemas.ActivityLogActorTypeLabelEnum.Admin,
        actorName: "Ana Ruiz",
        action: "Renamed chatbot",
        on: "Help desk",
      },
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        actorTypeLabel: Schemas.ActivityLogActorTypeLabelEnum.Admin,
        actorName: "Ana Ruiz",
        action: "Paused chatbot",
        on: "Help desk",
      },
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
        actorTypeLabel: Schemas.ActivityLogActorTypeLabelEnum.Admin,
        actorName: "Ana Ruiz",
        action: "Created chatbot",
        on: "Support",
      },
      {
        actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
        actorTypeLabel: Schemas.ActivityLogActorTypeLabelEnum.Operator,
        actorName: null,
        action: "Activated tool",
        on: "update_record v2",
      },
    ]);
    expect(entries[0]).not.toHaveProperty("id");

    const counted = await call("GET", "/dashboard/audit-log/count", { as: adminA });
    expect(counted.body.totalRecords).toBe(4);

    const paged = await call("GET", "/dashboard/audit-log?pageNo=2&pageSize=3", { as: adminA });
    expect(paged.body.auditLog?.map((entry) => entry.action)).toEqual(["Activated tool"]);

    const exported = await call("GET", "/dashboard/audit-log/export", { as: adminA });
    expect(exported.status).toBe(200);
    expect(exported.body.auditLog).toEqual(listed.body.auditLog);
    expect(exported.body.isTruncated).toBe(false);

    // DEV_NOTE: Every audit row went out through the outbox (a critical event), relayed after the commit
    let outboxCount = 0;
    await withOwnerDb(async (ownerDb) => {
      const conditions = [
        eq(eventOutbox.companyId, companyA),
        inArray(eventOutbox.eventType, [
          Schemas.auditEventType(
            Schemas.AuditEntityTypeEnum.Chatbot,
            Schemas.AuditEntityActionEnum.Created,
          ),
          Schemas.auditEventType(
            Schemas.AuditEntityTypeEnum.Chatbot,
            Schemas.AuditEntityActionEnum.Updated,
          ),
          Schemas.auditEventType(
            Schemas.AuditEntityTypeEnum.Chatbot,
            Schemas.AuditEntityActionEnum.Paused,
          ),
        ]),
      ];
      outboxCount = (
        await ownerDb
          .select()
          .from(eventOutbox)
          .where(and(...conditions))
      ).length;
    });
    expect(outboxCount).toBe(3);
  });

  it("never shows another company's rows", async () => {
    const listed = await call("GET", "/dashboard/audit-log", { as: adminB });
    expect(listed.status).toBe(200);
    expect(listed.body.auditLog).toEqual([]);
    const counted = await call("GET", "/dashboard/audit-log/count", { as: adminB });
    expect(counted.body.totalRecords).toBe(0);
  });

  it("refuses an operator (403) and the signed out (401)", async () => {
    expect((await call("GET", "/dashboard/audit-log", { as: operator })).status).toBe(403);
    expect((await call("GET", "/dashboard/audit-log/export", { as: operator })).status).toBe(403);
    expect((await call("GET", "/dashboard/audit-log")).status).toBe(401);
  });
});

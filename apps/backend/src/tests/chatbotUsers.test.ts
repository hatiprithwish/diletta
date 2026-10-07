import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { chatbotUsers, companies } from "@/db/tables";
import ChatbotUsersRepo from "@/repositories/ChatbotUsersRepo";
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

// DEV_NOTE: Tests hit the Neon staging branch. Two fresh companies per run isolate rows; afterAll deletes
// every chatbot user and company this suite created. The Repo runs as diletta_app (HYPERDRIVE), so RLS
// applies; fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
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

const hostUserId = () => `host_${crypto.randomUUID()}`;

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Test company A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Test company B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
  });
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("ChatbotUsersRepo", () => {
  it("creates, reads, lists and updates a chatbot user", async () => {
    const repo = new ChatbotUsersRepo(env);
    const sub = hostUserId();

    const created = await repo.createChatbotUser({
      companyId: companyA,
      chatbotUser: { hostUserId: sub },
    });
    expect(created.isSuccess).toBe(true);
    expect(created.chatbotUser).not.toHaveProperty("id");
    expect(created.chatbotUser).not.toHaveProperty("companyId");
    expect(created.chatbotUser?.hostUserId).toBe(sub);
    expect(created.chatbotUser?.displayName).toBeNull();
    expect(created.chatbotUser?.erasedAt).toBeNull();

    const fetched = await repo.getChatbotUserDetails({ companyId: companyA, hostUserId: sub });
    expect(fetched.isSuccess).toBe(true);
    expect(fetched.chatbotUser?.hostUserId).toBe(sub);

    const listed = await repo.getChatbotUsers({ companyId: companyA });
    expect(listed.isSuccess).toBe(true);
    expect(listed.chatbotUsers?.some((chatbotUser) => chatbotUser.hostUserId === sub)).toBe(true);

    const renamed = await repo.updateChatbotUser({
      companyId: companyA,
      hostUserId: sub,
      chatbotUser: { displayName: "Asha" },
    });
    expect(renamed.isSuccess).toBe(true);
    expect(renamed.chatbotUser?.displayName).toBe("Asha");
  });

  it("refuses a second chatbot user with the same host user id in one company", async () => {
    const repo = new ChatbotUsersRepo(env);
    const sub = hostUserId();

    const first = await repo.createChatbotUser({
      companyId: companyA,
      chatbotUser: { hostUserId: sub },
    });
    expect(first.isSuccess).toBe(true);

    const duplicate = await repo.createChatbotUser({
      companyId: companyA,
      chatbotUser: { hostUserId: sub },
    });
    expect(duplicate).toEqual({
      isSuccess: false,
      message: "Chatbot user already exists",
      chatbotUser: undefined,
    });

    // DEV_NOTE: host user ids are unique per company, so another company may use the same one
    const otherCompany = await repo.createChatbotUser({
      companyId: companyB,
      chatbotUser: { hostUserId: sub },
    });
    expect(otherCompany.isSuccess).toBe(true);
  });

  it("never reads or writes another company's chatbot user", async () => {
    const repo = new ChatbotUsersRepo(env);
    const sub = hostUserId();
    await repo.createChatbotUser({
      companyId: companyA,
      chatbotUser: { hostUserId: sub, displayName: "Private" },
    });

    const fetched = await repo.getChatbotUserDetails({ companyId: companyB, hostUserId: sub });
    expect(fetched.isSuccess).toBe(false);

    const listed = await repo.getChatbotUsers({ companyId: companyB });
    expect(listed.chatbotUsers?.some((chatbotUser) => chatbotUser.hostUserId === sub)).toBe(false);

    const updated = await repo.updateChatbotUser({
      companyId: companyB,
      hostUserId: sub,
      chatbotUser: { displayName: "Hijacked" },
    });
    expect(updated.isSuccess).toBe(false);

    const untouched = await repo.getChatbotUserDetails({ companyId: companyA, hostUserId: sub });
    expect(untouched.chatbotUser?.displayName).toBe("Private");
  });

  it("refuses to create a chatbot user for a company that does not exist", async () => {
    const repo = new ChatbotUsersRepo(env);
    // DEV_NOTE: identity ids start at 1, so 0 never references a company
    const result = await repo.createChatbotUser({
      companyId: "0",
      chatbotUser: { hostUserId: hostUserId() },
    });
    expect(result).toEqual({
      isSuccess: false,
      message: "Company not found",
      chatbotUser: undefined,
    });
  });
});

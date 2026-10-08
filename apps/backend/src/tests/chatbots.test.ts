import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { chatbots, companies } from "@/db/tables";
import ChatbotsRepo from "@/repositories/ChatbotsRepo";
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

// DEV_NOTE: Tests hit the Neon staging branch. Two fresh companies per run isolate rows;
// afterAll deletes every chatbot and company this suite created. The Repo runs as diletta_app (HYPERDRIVE),
// so RLS applies; fixtures and cleanup run as the owner, since only withPlatform may create companies.
// DEV_NOTE: Test-only binding from apps/backend/.env, passed in by vitest.config.mts. Read through `in`
// narrowing so neither the worker's Env nor a test-only type has to declare it.
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
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("ChatbotsRepo (tenant golden)", () => {
  it("creates, reads, lists, updates and deletes a chatbot", async () => {
    const repo = new ChatbotsRepo(env);

    const created = await repo.createChatbot({ companyId: companyA, chatbot: { name: "Support" } });
    expect(created.isSuccess).toBe(true);
    const publicId = created.chatbot?.publicId ?? "";
    expect(publicId).toBeTruthy();
    expect(created.chatbot).not.toHaveProperty("id");
    expect(created.chatbot).not.toHaveProperty("companyId");
    expect(created.chatbot).not.toHaveProperty("createdBy");
    expect(created.chatbot).not.toHaveProperty("updatedBy");
    expect(created.chatbot?.isDefault).toBe(false);
    expect(created.chatbot?.chatbotStatus).toBe(Schemas.ChatbotStatusIntEnum.Active);
    expect(created.chatbot?.chatbotStatusLabel).toBe(Schemas.ChatbotStatusLabelEnum.Active);

    const fetched = await repo.getChatbotDetails({ companyId: companyA, publicId });
    expect(fetched.isSuccess).toBe(true);
    expect(fetched.chatbot?.name).toBe("Support");

    const listed = await repo.getChatbots({ companyId: companyA });
    expect(listed.isSuccess).toBe(true);
    expect(listed.chatbots?.some((chatbot) => chatbot.publicId === publicId)).toBe(true);

    // Partial update: omitted name is left unchanged
    const paused = await repo.updateChatbot({
      companyId: companyA,
      publicId,
      chatbot: { status: Schemas.ChatbotStatusIntEnum.Paused },
    });
    expect(paused.isSuccess).toBe(true);
    expect(paused.chatbot?.name).toBe("Support");
    expect(paused.chatbot?.chatbotStatusLabel).toBe(Schemas.ChatbotStatusLabelEnum.Paused);

    const deleted = await repo.deleteChatbot({ companyId: companyA, publicId });
    expect(deleted.isSuccess).toBe(true);

    const missing = await repo.getChatbotDetails({ companyId: companyA, publicId });
    expect(missing).toEqual({
      isSuccess: false,
      message: "Chatbot not found",
      isNotFound: true,
      chatbot: undefined,
    });

    const deletedAgain = await repo.deleteChatbot({ companyId: companyA, publicId });
    expect(deletedAgain).toEqual({
      isSuccess: false,
      message: "Chatbot not found",
      isNotFound: true,
    });
  });

  it("never reads or writes another company's chatbot", async () => {
    const repo = new ChatbotsRepo(env);
    const created = await repo.createChatbot({ companyId: companyA, chatbot: { name: "Private" } });
    const publicId = created.chatbot?.publicId ?? "";

    const fetched = await repo.getChatbotDetails({ companyId: companyB, publicId });
    expect(fetched.isSuccess).toBe(false);

    const listed = await repo.getChatbots({ companyId: companyB });
    expect(listed.chatbots?.some((chatbot) => chatbot.publicId === publicId)).toBe(false);

    const updated = await repo.updateChatbot({
      companyId: companyB,
      publicId,
      chatbot: { name: "Hijacked" },
    });
    expect(updated.isSuccess).toBe(false);

    const deleted = await repo.deleteChatbot({ companyId: companyB, publicId });
    expect(deleted.isSuccess).toBe(false);

    const untouched = await repo.getChatbotDetails({ companyId: companyA, publicId });
    expect(untouched.chatbot?.name).toBe("Private");
  });

  it("refuses to create a chatbot for a company that does not exist", async () => {
    const repo = new ChatbotsRepo(env);
    // DEV_NOTE: identity ids start at 1, so 0 never references a company
    const result = await repo.createChatbot({ companyId: "0", chatbot: { name: "Orphan" } });
    expect(result).toEqual({ isSuccess: false, message: "Company not found", chatbot: undefined });
  });

  it("switches the default chatbot and rolls back when the new one is missing", async () => {
    const repo = new ChatbotsRepo(env);
    const first = await repo.createChatbot({ companyId: companyB, chatbot: { name: "First" } });
    const second = await repo.createChatbot({ companyId: companyB, chatbot: { name: "Second" } });
    const firstId = first.chatbot?.publicId ?? "";
    const secondId = second.chatbot?.publicId ?? "";

    const firstDefault = await repo.setDefaultChatbot({ companyId: companyB, publicId: firstId });
    expect(firstDefault.isSuccess).toBe(true);
    expect(firstDefault.chatbot?.isDefault).toBe(true);

    // Missing target: clearing the old default must roll back with the failed step
    const failed = await repo.setDefaultChatbot({
      companyId: companyB,
      publicId: "does-not-exist",
    });
    expect(failed).toEqual({ isSuccess: false, message: "Chatbot not found" });
    const stillDefault = await repo.getChatbotDetails({ companyId: companyB, publicId: firstId });
    expect(stillDefault.chatbot?.isDefault).toBe(true);

    const switched = await repo.setDefaultChatbot({ companyId: companyB, publicId: secondId });
    expect(switched.isSuccess).toBe(true);
    expect(switched.chatbot?.isDefault).toBe(true);

    const listed = await repo.getChatbots({ companyId: companyB });
    const defaults = listed.chatbots?.filter((chatbot) => chatbot.isDefault) ?? [];
    expect(defaults.map((chatbot) => chatbot.publicId)).toEqual([secondId]);
  });
});

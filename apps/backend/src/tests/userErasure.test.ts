import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  chatbotUserSecrets,
  chatbotUsers,
  chatbots,
  companies,
  companyConnections,
  conversations,
  eventOutbox,
  feedback,
  messages,
  qualityIssues,
} from "@/db/tables";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import AppLogger from "@/providers/logger";
import ContentRetentionRepo from "@/repositories/ContentRetentionRepo";
import UserErasureRepo from "@/repositories/UserErasureRepo";
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

// DEV_NOTE: M6-2 "Done when": an erased user's chats, files and secrets are gone. The Repos run as diletta_app (HYPERDRIVE);
// fixtures and checks run as the owner. The purge's steps per table, transcripts included, are covered in
// contentRetention.test.ts, and the DO wipe in actionConversation.test.ts: these chats' DOs were never connected, so their
// wipe is a no-op success. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const BYTES = Buffer.from([1, 2, 3]);

const companyIds: string[] = [];
let companyId = "";
let otherCompanyId = "";
let adminId = "";
let chatbotId = "";
let otherChatbotId = "";
let connectionId = "";
let otherConnectionId = "";

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

// DEV_NOTE: A user with a saved credential and one Open chat holding a message, a comment and an admin's note
async function seedUser(params: { companyId: string; chatbotId: string; connectionId: string }) {
  const hostUserId = `u-${crypto.randomUUID()}`;
  return await withOwnerDb(async (ownerDb) => {
    const [user] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId: params.companyId, hostUserId, displayName: "Ana Ruiz" })
      .returning({ id: chatbotUsers.id });
    const chatbotUserId = user!.id;
    await ownerDb.insert(chatbotUserSecrets).values({
      publicId: Utility.generatePublicId(),
      companyId: params.companyId,
      chatbotUserId,
      connectionId: params.connectionId,
      type: Schemas.CompanyConnectionAuthTypeEnum.Oauth2Authcode,
      encryptedSecret: BYTES,
      iv: BYTES,
      encryptionKeyVersion: 1,
    });
    const conversationPublicId = await seedChat(ownerDb, params, chatbotUserId);
    return { hostUserId, chatbotUserId, conversationPublicId };
  });
}

async function seedChat(
  ownerDb: NodePgDatabase,
  params: { companyId: string; chatbotId: string },
  chatbotUserId: string,
): Promise<string> {
  const publicId = Utility.generatePublicId();
  const [conversation] = await ownerDb
    .insert(conversations)
    .values({
      publicId,
      companyId: params.companyId,
      chatbotId: params.chatbotId,
      chatbotUserId,
      title: "My address is 12 Elm Street",
    })
    .returning({ id: conversations.id });
  const conversationId = conversation!.id;
  const [message] = await ownerDb
    .insert(messages)
    .values({
      publicId: Utility.generatePublicId(),
      companyId: params.companyId,
      conversationId,
      sessionMessageId: "m1",
      turnId: Utility.generateUlid(Date.now()),
      role: Schemas.MessageRoleIntEnum.User,
      content: { text: "My address is 12 Elm Street" },
    })
    .returning({ id: messages.id });
  await ownerDb.insert(feedback).values({
    publicId: Utility.generatePublicId(),
    companyId: params.companyId,
    messageId: message!.id,
    chatbotUserId,
    rating: Schemas.FeedbackRatingIntEnum.Down,
    comment: "It got 12 Elm Street wrong",
  });
  await ownerDb.insert(qualityIssues).values({
    publicId: Utility.generatePublicId(),
    companyId: params.companyId,
    chatbotId: params.chatbotId,
    conversationId,
    source: Schemas.QualityIssueSourceIntEnum.Admin,
    createdBy: adminId,
    note: "Ana Ruiz says it got her address wrong",
    issueType: Schemas.QualityIssueTypeIntEnum.ModelError,
  });
  return publicId;
}

const readChat = (publicId: string) =>
  withOwnerDb(async (ownerDb) => {
    const [conversation] = await ownerDb
      .select()
      .from(conversations)
      .where(eq(conversations.publicId, publicId));
    const conversationId = conversation!.id;
    const [message] = await ownerDb
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const [issue] = await ownerDb
      .select()
      .from(qualityIssues)
      .where(eq(qualityIssues.conversationId, conversationId));
    const [rating] = await ownerDb
      .select()
      .from(feedback)
      .where(eq(feedback.messageId, message!.id));
    return { conversation: conversation!, message: message!, issue: issue!, rating: rating! };
  });

const readUser = (chatbotUserId: string) =>
  withOwnerDb(async (ownerDb) => {
    const [user] = await ownerDb
      .select()
      .from(chatbotUsers)
      .where(eq(chatbotUsers.id, chatbotUserId));
    const secrets = await ownerDb
      .select({ id: chatbotUserSecrets.id })
      .from(chatbotUserSecrets)
      .where(eq(chatbotUserSecrets.chatbotUserId, chatbotUserId));
    return { user: user!, secretCount: secrets.length };
  });

const erase = (hostUserId: string, company = companyId) =>
  new UserErasureRepo(env).eraseUser({ companyId: company, adminId, hostUserId });

const purgeHourly = () =>
  new ContentRetentionRepo(env).purgeExpiredContent({ companyIds: [companyId] });

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Erasure A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Erasure B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyId = created[0]!.id;
    otherCompanyId = created[1]!.id;
    companyIds.push(companyId, otherCompanyId);
    const [admin] = await ownerDb
      .insert(admins)
      .values({ clerkUserId: `user_erase_${crypto.randomUUID()}`, companyId })
      .returning({ id: admins.id });
    adminId = admin!.id;
    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId, name: "A" },
        { publicId: Utility.generatePublicId(), companyId: otherCompanyId, name: "B" },
      ])
      .returning({ id: chatbots.id });
    chatbotId = bots[0]!.id;
    otherChatbotId = bots[1]!.id;
    const connections = await ownerDb
      .insert(companyConnections)
      .values(
        [companyId, otherCompanyId].map((id) => ({
          publicId: Utility.generatePublicId(),
          companyId: id,
          environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
          baseUrl: "https://host.example.com",
          authType: Schemas.CompanyConnectionAuthTypeEnum.Oauth2Authcode,
          authConfig: { tokenUrl: "https://host.example.com/token" },
          credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.ChatbotUser,
          jwtIssuer: `https://issuer-${crypto.randomUUID()}.example.com`,
          allowedOrigins: ["https://host.example.com"],
        })),
      )
      .returning({ id: companyConnections.id });
    connectionId = connections[0]!.id;
    otherConnectionId = connections[1]!.id;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(AppLogger.error).mockClear();
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(feedback).where(inArray(feedback.companyId, companyIds));
    await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb
      .delete(chatbotUserSecrets)
      .where(inArray(chatbotUserSecrets.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("User erasure (M6-2)", () => {
  const seed = () => seedUser({ companyId, chatbotId, connectionId });

  it("takes the identity and credentials at once, and clears the notes on their chats", async () => {
    const { hostUserId, chatbotUserId, conversationPublicId } = await seed();

    const erased = await erase(hostUserId);
    expect(erased).toMatchObject({ isSuccess: true, conversationCount: 1, chatbotUserId });

    const { user, secretCount } = await readUser(chatbotUserId);
    expect(secretCount).toBe(0);
    expect(user.erasedAt).not.toBeNull();
    expect(user.displayName).toBeNull();
    expect(user.hostUserId).not.toBe(hostUserId);
    expect(user.hostUserId.startsWith("erased:")).toBe(true);
    expect((await readChat(conversationPublicId)).issue.note).toBeNull();
  });

  it("then purges their chats whatever their age, and keeps the anonymous rows", async () => {
    const { hostUserId, chatbotUserId, conversationPublicId } = await seed();
    await erase(hostUserId);

    const purged = await new ContentRetentionRepo(env).purgeErasedUserContent({
      companyId,
      chatbotUserId,
    });
    expect(purged).toMatchObject({ isSuccess: true, purgedCount: 1, skippedCount: 0 });

    const { conversation, message, issue, rating } = await readChat(conversationPublicId);
    expect(conversation.contentPurgedAt).not.toBeNull();
    expect(conversation.title).toBeNull();
    expect(conversation.status).not.toBe(Schemas.ConversationStatusIntEnum.Open);
    expect(message.content).toBeNull();
    expect(rating.comment).toBeNull();
    expect(rating.rating).toBe(Schemas.FeedbackRatingIntEnum.Down);
    expect(issue.issueType).toBe(Schemas.QualityIssueTypeIntEnum.ModelError);
    expect(issue.note).toBeNull();
  });

  it("leaves a chat the first pass missed to the hourly run, recent as it is", async () => {
    const { hostUserId, conversationPublicId } = await seed();
    await erase(hostUserId);
    expect((await readChat(conversationPublicId)).conversation.contentPurgedAt).toBeNull();

    await purgeHourly();
    expect((await readChat(conversationPublicId)).conversation.contentPurgedAt).not.toBeNull();
  });

  it("picks up a chat started as the user was erased, and clears its note", async () => {
    const { hostUserId, chatbotUserId, conversationPublicId } = await seed();
    await erase(hostUserId);
    const late = await withOwnerDb((ownerDb) =>
      seedChat(ownerDb, { companyId, chatbotId }, chatbotUserId),
    );

    await purgeHourly();
    for (const publicId of [conversationPublicId, late]) {
      const { conversation, issue } = await readChat(publicId);
      expect(conversation.contentPurgedAt).not.toBeNull();
      expect(issue.note).toBeNull();
    }
  });

  it("leaves a chat with a turn running as it is, then finishes it next run", async () => {
    const { hostUserId, chatbotUserId, conversationPublicId } = await seed();
    await erase(hostUserId);
    const wipe = vi
      .spyOn(
        ContentRetentionRepo.prototype as unknown as {
          wipeConversationDo: () => Promise<boolean>;
        },
        "wipeConversationDo",
      )
      .mockResolvedValue(false);

    expect(
      await new ContentRetentionRepo(env).purgeErasedUserContent({ companyId, chatbotUserId }),
    ).toMatchObject({ purgedCount: 0, skippedCount: 1 });
    const busy = (await readChat(conversationPublicId)).conversation;
    expect(busy.status).toBe(Schemas.ConversationStatusIntEnum.Open);
    expect(busy.outcome).toBeNull();
    expect(busy.contentPurgedAt).toBeNull();

    wipe.mockRestore();
    await purgeHourly();
    const done = (await readChat(conversationPublicId)).conversation;
    expect(done.status).toBe(Schemas.ConversationStatusIntEnum.Closed);
    expect(done.contentPurgedAt).not.toBeNull();
  });

  it("works through more chats than one batch in the first pass, past one it skips", async () => {
    const { hostUserId, chatbotUserId, conversationPublicId } = await seed();
    const more = await withOwnerDb(async (ownerDb) => [
      await seedChat(ownerDb, { companyId, chatbotId }, chatbotUserId),
      await seedChat(ownerDb, { companyId, chatbotId }, chatbotUserId),
    ]);
    await erase(hostUserId);
    const wipe = ContentRetentionRepo.prototype as unknown as {
      wipeConversationDo: (row: { publicId: string }) => Promise<boolean>;
    };
    const realWipe = wipe.wipeConversationDo;
    vi.spyOn(wipe, "wipeConversationDo").mockImplementation(function (
      this: unknown,
      row: { publicId: string },
    ) {
      if (row.publicId === conversationPublicId) return Promise.resolve(false);
      return realWipe.call(this, row);
    });

    expect(
      await new ContentRetentionRepo(env).purgeErasedUserContent({
        companyId,
        chatbotUserId,
        batchSize: 1,
      }),
    ).toMatchObject({ isSuccess: true, purgedCount: 2, skippedCount: 1 });
    for (const publicId of more) {
      expect((await readChat(publicId)).conversation.contentPurgedAt).not.toBeNull();
    }
    vi.restoreAllMocks();
    await purgeHourly();
  });

  it("doesn't touch another user's recent chat", async () => {
    const erasedUser = await seed();
    const other = await seed();
    await erase(erasedUser.hostUserId);

    await purgeHourly();
    const { conversation, message, issue } = await readChat(other.conversationPublicId);
    expect(conversation.contentPurgedAt).toBeNull();
    expect(message.content).not.toBeNull();
    expect(issue.note).not.toBeNull();
    expect((await readUser(other.chatbotUserId)).secretCount).toBe(1);
  });

  it("alerts when an erased user's chat is still there a day on, not before", async () => {
    const { hostUserId, chatbotUserId } = await seed();
    await erase(hostUserId);
    vi.spyOn(ConversationsDAL.prototype, "closeConversationPastRetention").mockResolvedValue({
      isSuccess: false,
      message: "Keeps failing",
    });
    const run = (now?: number) =>
      new ContentRetentionRepo(env).purgeExpiredContent({ companyIds: [companyId], now });

    expect(await run()).toMatchObject({ overdueCompanyCount: 0 });
    expect(await run(Date.now() + 25 * 60 * 60_000)).toMatchObject({ overdueCompanyCount: 1 });
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Chat content is overdue for deletion" }),
    );

    vi.restoreAllMocks();
    await new ContentRetentionRepo(env).purgeErasedUserContent({ companyId, chatbotUserId });
  });

  it("alerts when the overdue read itself fails, so it can't pass for a healthy run", async () => {
    const { hostUserId } = await seed();
    await erase(hostUserId);
    vi.spyOn(ConversationsDAL.prototype, "closeConversationPastRetention").mockResolvedValue({
      isSuccess: false,
      message: "Keeps failing",
    });
    vi.spyOn(ConversationsDAL.prototype, "getOldestErasedUserPending").mockResolvedValue({
      isSuccess: false,
      message: "Read failed",
    });

    expect(await purgeHourly()).toMatchObject({ overdueCompanyCount: 1 });
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "unreadable" }),
      }),
    );

    vi.restoreAllMocks();
    await purgeHourly();
  });

  it("answers not found for an unknown id and for one already erased, writing nothing", async () => {
    const { hostUserId } = await seed();
    await erase(hostUserId);
    const audited = () =>
      withOwnerDb(async (ownerDb) => {
        const conditions = [
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityAction, Schemas.AuditEntityActionEnum.UserErased),
        ];
        return await ownerDb
          .select({ id: activityLog.id })
          .from(activityLog)
          .where(and(...conditions));
      });
    const before = (await audited()).length;

    expect(await erase(hostUserId)).toMatchObject({ isSuccess: false, isNotFound: true });
    expect(await erase("no-such-user")).toMatchObject({ isSuccess: false, isNotFound: true });
    expect((await audited()).length).toBe(before);
  });

  it("records the audit row with a chat count, and the id nowhere", async () => {
    const { hostUserId } = await seed();
    const company = await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb.select().from(companies).where(eq(companies.id, companyId));
      return row!;
    });
    await erase(hostUserId);

    const rows = await withOwnerDb(async (ownerDb) => {
      const conditions = [
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityAction, Schemas.AuditEntityActionEnum.UserErased),
        eq(activityLog.entityId, company.id),
      ];
      return await ownerDb
        .select()
        .from(activityLog)
        .where(and(...conditions));
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actorType).toBe(Schemas.ActivityLogActorTypeIntEnum.Admin);
      expect(row.detail).toEqual({ label: expect.stringMatching(/^\d+ chats?$/) });
      expect(JSON.stringify(row)).not.toContain(hostUserId);
    }
  });

  it("can't reach another company's user", async () => {
    const other = await seedUser({
      companyId: otherCompanyId,
      chatbotId: otherChatbotId,
      connectionId: otherConnectionId,
    });

    expect(await erase(other.hostUserId)).toMatchObject({ isSuccess: false, isNotFound: true });
    const { user, secretCount } = await readUser(other.chatbotUserId);
    expect(user.erasedAt).toBeNull();
    expect(user.hostUserId).toBe(other.hostUserId);
    expect(secretCount).toBe(1);
    const { issue } = await readChat(other.conversationPublicId);
    expect(issue.note).not.toBeNull();
  });

  it("gives a return with the same id a new, empty user", async () => {
    const { hostUserId, chatbotUserId } = await seed();
    await erase(hostUserId);

    const again = await withOwnerDb(async (ownerDb) => {
      const [user] = await ownerDb
        .insert(chatbotUsers)
        .values({ companyId, hostUserId })
        .returning({ id: chatbotUsers.id });
      return user!.id;
    });
    expect(again).not.toBe(chatbotUserId);
    expect((await readUser(chatbotUserId)).user.erasedAt).not.toBeNull();
    expect((await readUser(again)).user.erasedAt).toBeNull();
  });
});

import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  chatbotUsers,
  chatbots,
  companies,
  companyConnections,
  conversations,
  messages,
} from "@/db/tables";
import worker from "@/index";
import Utility from "@/utils/Utility";
import { claimsFor, createKey, seedJwks, signToken } from "@/tests/helpers/widgetJwt";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: The widget's history (Your chats): GET /widget/conversations and /widget/conversations/:publicId. Tests hit
// the Neon staging branch; the Repo runs as diletta_app (HYPERDRIVE), so RLS applies. Fixtures and cleanup run as the
// owner. One host user ("host-user-1", claimsFor's sub) has chats in company A with both its chatbots; another user of
// A, and the same host user id in company B, have their own, which must never show.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";

const ORIGIN = "https://app.example.com";
const USER = "host-user-1";
const issuers = {
  a: `https://${crypto.randomUUID()}.example.com`,
  b: `https://${crypto.randomUUID()}.example.com`,
};

const companyIds: string[] = [];
let companyA = "";
let secondChatbotA = "";
let key: Awaited<ReturnType<typeof createKey>>;

// DEV_NOTE: The chats' public ids, by what each one tests
const chat = {
  open: Utility.generatePublicId(),
  ended: Utility.generatePublicId(),
  untitled: Utility.generatePublicId(),
  purged: Utility.generatePublicId(),
  evalChat: Utility.generatePublicId(),
  secondChatbot: Utility.generatePublicId(),
  otherUser: Utility.generatePublicId(),
  otherCompany: Utility.generatePublicId(),
};

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

beforeAll(async () => {
  key = await createKey(Schemas.WidgetJwtAlgorithmEnum.RS256, "rs-history");

  await withOwnerDb(async (ownerDb) => {
    const [a, b] = (
      await ownerDb
        .insert(companies)
        .values([
          { publicId: Utility.generatePublicId(), name: `History A ${crypto.randomUUID()}` },
          { publicId: Utility.generatePublicId(), name: `History B ${crypto.randomUUID()}` },
        ])
        .returning({ id: companies.id })
    ).map((row) => row.id) as [string, string];
    companyA = a;
    companyIds.push(a, b);

    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId: a, name: "A default", isDefault: true },
        { publicId: Utility.generatePublicId(), companyId: a, name: "A second" },
        { publicId: Utility.generatePublicId(), companyId: b, name: "B default", isDefault: true },
      ])
      .returning({ id: chatbots.id, publicId: chatbots.publicId });
    const [botA, botA2, botB] = bots as [(typeof bots)[0], (typeof bots)[0], (typeof bots)[0]];
    secondChatbotA = botA2.publicId;

    const connection = (companyId: string, jwtIssuer: string) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
      baseUrl: "https://host.example.com/api",
      authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      authConfig: {},
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      jwtIssuer,
      allowedOrigins: [ORIGIN],
      status: Schemas.CompanyConnectionStatusIntEnum.Active,
    });
    await ownerDb
      .insert(companyConnections)
      .values([connection(a, issuers.a), connection(b, issuers.b)]);

    const users = await ownerDb
      .insert(chatbotUsers)
      .values([
        { companyId: a, hostUserId: USER },
        { companyId: a, hostUserId: "host-user-2" },
        { companyId: b, hostUserId: USER },
      ])
      .returning({ id: chatbotUsers.id });
    const [userA, otherUserA, userB] = users.map((row) => row.id) as [string, string, string];

    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const conversationRow = (
      publicId: string,
      companyId: string,
      chatbotUserId: string,
      chatbotId: string,
      minutesAgo: number,
      extra: Partial<typeof conversations.$inferInsert> = {},
    ): typeof conversations.$inferInsert => ({
      publicId,
      companyId,
      chatbotUserId,
      chatbotId,
      title: `Chat ${publicId}`,
      status: Schemas.ConversationStatusIntEnum.Closed,
      lastActivityAt: at(minutesAgo),
      ...extra,
    });
    const rows = await ownerDb
      .insert(conversations)
      .values([
        conversationRow(chat.open, a, userA, botA.id, 5, {
          title: "Which inspections are overdue this week?",
          status: Schemas.ConversationStatusIntEnum.Open,
        }),
        conversationRow(chat.ended, a, userA, botA.id, 60, {
          title: "Add a fire drill for Hall B on Friday",
        }),
        conversationRow(chat.untitled, a, userA, botA.id, 1, { title: null }),
        conversationRow(chat.purged, a, userA, botA.id, 2, {
          title: null,
          contentPurgedAt: new Date(),
        }),
        conversationRow(chat.evalChat, a, userA, botA.id, 3, {
          evalRunId: "900000000001",
          evalCaseId: "900000000001",
          evalAttempt: 1,
          evalTry: 0,
        }),
        conversationRow(chat.secondChatbot, a, userA, botA2.id, 10),
        conversationRow(chat.otherUser, a, otherUserA, botA.id, 4),
        conversationRow(chat.otherCompany, b, userB, botB.id, 4),
      ])
      .returning({ id: conversations.id, publicId: conversations.publicId });
    const endedId = rows.find((row) => row.publicId === chat.ended)!.id;

    const message = (
      role: Schemas.MessageRoleIntEnum,
      content: unknown,
      turnId: string,
    ): typeof messages.$inferInsert => ({
      publicId: Utility.generatePublicId(),
      companyId: a,
      conversationId: endedId,
      sessionMessageId: crypto.randomUUID(),
      turnId,
      role,
      content,
    });
    await ownerDb.insert(messages).values([
      message(Schemas.MessageRoleIntEnum.User, { text: "Add a fire drill for Hall B" }, "t1"),
      message(
        Schemas.MessageRoleIntEnum.Assistant,
        {
          text: "Which time works: 10:00 or 14:00? [1]",
          citations: [
            {
              n: 1,
              documentPublicId: "doc_fire",
              title: "Fire drill policy",
              sourceUrl: "https://help.example.com/fire-drills",
            },
          ],
        },
        "t1",
      ),
      message(Schemas.MessageRoleIntEnum.Tool, { text: "tool output" }, "t1"),
      message(Schemas.MessageRoleIntEnum.User, { text: "14:00 please" }, "t2"),
      message(Schemas.MessageRoleIntEnum.Assistant, null, "t2"),
      message(Schemas.MessageRoleIntEnum.Assistant, { text: "Done. Booked for 14:00." }, "t2"),
    ]);
  });
});

afterAll(async () => {
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(messages).where(inArray(messages.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

beforeEach(async () => {
  await Promise.all([seedJwks(issuers.a, [key.jwk]), seedJwks(issuers.b, [key.jwk])]);
});

async function call(
  path: string,
  options: {
    issuer?: string;
    sub?: string;
    origin?: string | null;
    authorization?: string | null;
    method?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin !== null) headers["Origin"] = origin;
  if (options.authorization !== null) {
    const claims = claimsFor(options.issuer ?? issuers.a, { sub: options.sub ?? USER });
    headers["Authorization"] = options.authorization ?? `Bearer ${await signToken(key, claims)}`;
  }
  return await worker.fetch(
    new Request(`http://localhost/widget${path}`, { method: options.method ?? "GET", headers }),
    env,
    createExecutionContext(),
  );
}

describe("GET /widget/conversations", () => {
  it("lists the user's own chats with this chatbot, last activity first, readable cross-origin", async () => {
    const response = await call("/conversations");
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const body = Schemas.ZWidgetConversationsApiResponse.parse(await response.json());
    // DEV_NOTE: Not the chat with no message yet, the purged one, the eval chat, the other chatbot's, the other user's
    // or the other company's
    expect(body.conversations).toEqual([
      {
        publicId: chat.open,
        title: "Which inspections are overdue this week?",
        isOpen: true,
        lastActivityAt: expect.any(String),
      },
      {
        publicId: chat.ended,
        title: "Add a fire drill for Hall B on Friday",
        isOpen: false,
        lastActivityAt: expect.any(String),
      },
    ]);
    expect(body.totalRecords).toBe(2);
  });

  it("lists the chats with the chatbot the query names", async () => {
    const body = Schemas.ZWidgetConversationsApiResponse.parse(
      await (await call(`/conversations?chatbot=${secondChatbotA}`)).json(),
    );
    expect(body.conversations?.map((item) => item.publicId)).toEqual([chat.secondChatbot]);
  });

  it("pages, with the total of every page", async () => {
    const body = Schemas.ZWidgetConversationsApiResponse.parse(
      await (await call("/conversations?pageNo=2")).json(),
    );
    expect(body.conversations).toEqual([]);
    expect(body.totalRecords).toBe(2);
  });

  it("answers an empty list to a user who has never chatted, and creates nothing", async () => {
    const counts = async () => {
      let found = { chatbotUsers: -1, conversations: -1, activity: -1 };
      await withOwnerDb(async (ownerDb) => {
        found = {
          chatbotUsers: await ownerDb.$count(chatbotUsers, eq(chatbotUsers.companyId, companyA)),
          conversations: await ownerDb.$count(conversations, eq(conversations.companyId, companyA)),
          activity: await ownerDb.$count(activityLog, eq(activityLog.companyId, companyA)),
        };
      });
      return found;
    };
    const before = await counts();
    const body = Schemas.ZWidgetConversationsApiResponse.parse(
      await (await call("/conversations", { sub: "host-user-new" })).json(),
    );
    expect(body.conversations).toEqual([]);
    expect(body.totalRecords).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("checks the token first: 401 without one, 403 on another origin, 400 only for a verified token", async () => {
    expect((await call("/conversations", { authorization: null })).status).toBe(401);
    expect((await call("/conversations?pageNo=0", { authorization: null })).status).toBe(401);
    expect((await call("/conversations", { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await call("/conversations?pageNo=0")).status).toBe(400);
  });

  it("answers a preflight for any origin, allowing only the Authorization header", async () => {
    const response = await call("/conversations", {
      method: "OPTIONS",
      authorization: null,
      origin: "https://host.example.org",
      headers: {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization");
  });
});

describe("GET /widget/conversations/:publicId", () => {
  it("reads one chat back: the user's messages and the replies with their sources", async () => {
    const response = await call(`/conversations/${chat.ended}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const body = Schemas.ZWidgetConversationApiResponse.parse(await response.json());
    // DEV_NOTE: Not the tool row or the reply with no content
    expect(body.conversation).toEqual({
      publicId: chat.ended,
      title: "Add a fire drill for Hall B on Friday",
      isOpen: false,
      lastActivityAt: expect.any(String),
      messages: [
        {
          publicId: expect.any(String),
          role: "user",
          text: "Add a fire drill for Hall B",
          citations: [],
        },
        {
          publicId: expect.any(String),
          role: "assistant",
          text: "Which time works: 10:00 or 14:00? [1]",
          citations: [
            {
              n: 1,
              documentPublicId: "doc_fire",
              title: "Fire drill policy",
              sourceUrl: "https://help.example.com/fire-drills",
            },
          ],
        },
        { publicId: expect.any(String), role: "user", text: "14:00 please", citations: [] },
        {
          publicId: expect.any(String),
          role: "assistant",
          text: "Done. Booked for 14:00.",
          citations: [],
        },
      ],
    });
  });

  it("answers 404 for a chat that isn't this user's with this chatbot, whatever the reason", async () => {
    for (const publicId of [
      chat.otherUser,
      chat.otherCompany,
      chat.secondChatbot,
      chat.purged,
      chat.untitled,
      chat.evalChat,
      "no-such-chat",
    ]) {
      const response = await call(`/conversations/${publicId}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ isSuccess: false, message: "Not found" });
    }
  });

  it("answers the other company's user only their own chat", async () => {
    expect((await call(`/conversations/${chat.otherCompany}`, { issuer: issuers.b })).status).toBe(
      200,
    );
    expect((await call(`/conversations/${chat.ended}`, { issuer: issuers.b })).status).toBe(404);
  });

  it("checks the token before the path: 401 without one, 400 only for a verified token", async () => {
    const tooLong = "x".repeat(65);
    expect((await call(`/conversations/${chat.ended}`, { authorization: null })).status).toBe(401);
    expect((await call(`/conversations/${tooLong}`, { authorization: null })).status).toBe(401);
    expect((await call(`/conversations/${tooLong}`)).status).toBe(400);
  });
});

import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  activityRollups,
  admins,
  chatbots,
  companies,
  eventOutbox,
  qualityIssues,
} from "@/db/tables";
import AppLogger from "@/providers/logger";
import ChatbotHealthRepo from "@/repositories/ChatbotHealthRepo";
import QualityIssuesRepo from "@/repositories/QualityIssuesRepo";
import Utility from "@/utils/Utility";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Daily production health per chatbot (M5-5) on the Neon staging branch, as diletta_app (the Repo's own
// transactions). The owner connection only seeds the fixtures (companies, chatbots, rollup rows standing in for the
// hourly rollup) and reads back what the check wrote; afterAll deletes every row the companies own.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const DAY = "2026-10-30";
let ownerPool: Pool;
let ownerDb: NodePgDatabase;
let companyA = "";
let companyB = "";
let adminAId = "";
const adminA = `user_health_${crypto.randomUUID()}`;

async function newChatbot(companyId: string, name: string) {
  const [chatbot] = await ownerDb
    .insert(chatbots)
    .values({ publicId: Utility.generatePublicId(), companyId, name, isDefault: false })
    .returning({ id: chatbots.id, publicId: chatbots.publicId });
  if (!chatbot) throw new Error("Chatbot not created");
  return chatbot;
}

// DEV_NOTE: Ratings per day: CHATBOT_HEALTH_BASELINE_DAYS normal days (2 down of 20), then the day under test
async function seedRatings(
  companyId: string,
  chatbotId: string,
  day: { up: number; down: number },
  baseline = { up: 18, down: 2 },
) {
  const rows = [];
  for (let offset = Schemas.CHATBOT_HEALTH_BASELINE_DAYS; offset >= 0; offset--) {
    const counts = offset === 0 ? day : baseline;
    const rowDay = Schemas.activityRollupAddDays(DAY, -offset);
    rows.push(
      {
        companyId,
        chatbotId,
        day: rowDay,
        metric: Schemas.ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[Schemas.FeedbackRatingIntEnum.Up],
        value: String(counts.up),
      },
      {
        companyId,
        chatbotId,
        day: rowDay,
        metric: Schemas.ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[Schemas.FeedbackRatingIntEnum.Down],
        value: String(counts.down),
      },
    );
  }
  await ownerDb.insert(activityRollups).values(rows);
}

async function healthIssues(chatbotId: string) {
  const conditions = [
    eq(qualityIssues.chatbotId, chatbotId),
    eq(qualityIssues.issueType, Schemas.QualityIssueTypeIntEnum.HealthDrop),
  ];
  return await ownerDb
    .select()
    .from(qualityIssues)
    .where(and(...conditions));
}

const dropAlerts = () =>
  vi
    .mocked(AppLogger.error)
    .mock.calls.filter(
      ([entry]) =>
        entry.action === Schemas.LogAction.RecordChatbotHealthDrop &&
        entry.message === "A chatbot's production health dropped",
    );

beforeAll(async () => {
  ownerPool = new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  ownerDb = drizzle({ client: ownerPool });
  const created = await ownerDb
    .insert(companies)
    .values([
      { publicId: Utility.generatePublicId(), name: `Health A ${crypto.randomUUID()}` },
      { publicId: Utility.generatePublicId(), name: `Health B ${crypto.randomUUID()}` },
    ])
    .returning({ id: companies.id });
  companyA = created[0]?.id ?? "";
  companyB = created[1]?.id ?? "";
  const [admin] = await ownerDb
    .insert(admins)
    .values({ clerkUserId: adminA, companyId: companyA })
    .returning({ id: admins.id });
  adminAId = admin?.id ?? "";
});

beforeEach(() => {
  vi.mocked(AppLogger.error).mockClear();
});

afterAll(async () => {
  try {
    const companyIds = [companyA, companyB].filter(Boolean);
    if (companyIds.length === 0) return;
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(activityRollups).where(inArray(activityRollups.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(eq(admins.clerkUserId, adminA));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  } finally {
    await ownerPool.end();
  }
});

describe("ChatbotHealthRepo.checkCompany", () => {
  it("opens one Health drop issue on a seeded regression, alerts once, and a rerun adds nothing", async () => {
    const chatbot = await newChatbot(companyA, "Regressed bot");
    await seedRatings(companyA, chatbot.id, { up: 6, down: 14 });

    const checked = await new ChatbotHealthRepo(env).checkCompany({
      companyId: companyA,
      day: DAY,
    });
    expect(checked).toMatchObject({ isSuccess: true, dropCount: 1 });

    const [issue, ...others] = await healthIssues(chatbot.id);
    expect(others).toHaveLength(0);
    expect(issue).toMatchObject({
      companyId: companyA,
      chatbotId: chatbot.id,
      conversationId: null,
      source: Schemas.QualityIssueSourceIntEnum.System,
      status: Schemas.QualityIssueStatusIntEnum.Open,
      note: "Oct 30: Replies rated down 70% (usually 10%).",
    });
    expect(dropAlerts()).toHaveLength(1);
    const opened = await ownerDb
      .select()
      .from(eventOutbox)
      .where(eq(eventOutbox.companyId, companyA));
    expect(opened.map((row) => row.eventType)).toContain(
      Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.Opened),
    );

    vi.mocked(AppLogger.error).mockClear();
    await new ChatbotHealthRepo(env).checkCompany({ companyId: companyA, day: DAY });
    expect(await healthIssues(chatbot.id)).toHaveLength(1);
    expect(dropAlerts()).toHaveLength(0);
    expect((await healthIssues(chatbot.id))[0]?.note).toBe(issue?.note);
  });

  it("adds a later day's drop to the open issue instead of opening another", async () => {
    const chatbot = await newChatbot(companyA, "Still regressed");
    await seedRatings(companyA, chatbot.id, { up: 6, down: 14 });
    await new ChatbotHealthRepo(env).checkCompany({ companyId: companyA, day: DAY });

    // DEV_NOTE: The next day drops too, against a baseline that already holds the first bad day
    const nextDay = Schemas.activityRollupAddDays(DAY, 1);
    await ownerDb.insert(activityRollups).values([
      {
        companyId: companyA,
        chatbotId: chatbot.id,
        day: nextDay,
        metric: Schemas.ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[Schemas.FeedbackRatingIntEnum.Up],
        value: "2",
      },
      {
        companyId: companyA,
        chatbotId: chatbot.id,
        day: nextDay,
        metric: Schemas.ACTIVITY_ROLLUP_FEEDBACK_KEY_MAP[Schemas.FeedbackRatingIntEnum.Down],
        value: "18",
      },
    ]);
    vi.mocked(AppLogger.error).mockClear();
    await new ChatbotHealthRepo(env).checkCompany({ companyId: companyA, day: nextDay });

    const issues = await healthIssues(chatbot.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.note?.split("\n")).toEqual([
      "Oct 30: Replies rated down 70% (usually 10%).",
      expect.stringMatching(/^Oct 31: Replies rated down 90% \(usually \d+%\)\.$/),
    ]);
    expect(dropAlerts()).toHaveLength(1);
  });

  it("stays quiet on a healthy chatbot and on too little traffic", async () => {
    const healthy = await newChatbot(companyA, "Healthy bot");
    await seedRatings(companyA, healthy.id, { up: 18, down: 2 });
    const quiet = await newChatbot(companyA, "Quiet bot");
    // DEV_NOTE: Every rating down, but fewer than the floor
    await seedRatings(companyA, quiet.id, { up: 0, down: 5 });

    await new ChatbotHealthRepo(env).checkCompany({ companyId: companyA, day: DAY });
    expect(await healthIssues(healthy.id)).toHaveLength(0);
    expect(await healthIssues(quiet.id)).toHaveLength(0);
  });

  it("keeps each company's check to its own chatbots", async () => {
    const chatbotB = await newChatbot(companyB, "Other company's bot");
    await seedRatings(companyB, chatbotB.id, { up: 6, down: 14 });

    await new ChatbotHealthRepo(env).checkCompany({ companyId: companyA, day: DAY });
    expect(await healthIssues(chatbotB.id)).toHaveLength(0);
    await new ChatbotHealthRepo(env).checkCompany({ companyId: companyB, day: DAY });
    const [issue] = await healthIssues(chatbotB.id);
    expect(issue?.companyId).toBe(companyB);
  });
});

describe("A Health drop issue on the Quality page", () => {
  it("lists under its chatbot with no conversation, and never becomes a test", async () => {
    const chatbot = await newChatbot(companyA, "Listed bot");
    await seedRatings(companyA, chatbot.id, { up: 6, down: 14 });
    await new ChatbotHealthRepo(env).checkCompany({ companyId: companyA, day: DAY });
    const [issue] = await healthIssues(chatbot.id);
    const publicId = issue?.publicId ?? "";

    const repo = new QualityIssuesRepo(env);
    const listed = await repo.getQualityIssues({ companyId: companyA, botId: chatbot.publicId });
    expect(listed.qualityIssues?.map((row) => row.publicId)).toEqual([publicId]);
    expect(listed.qualityIssues?.[0]).toMatchObject({
      chatbotName: "Listed bot",
      conversation: null,
      issueTypeLabel: Schemas.QualityIssueTypeLabelEnum.HealthDrop,
      sourceLabel: Schemas.QualityIssueSourceLabelEnum.System,
    });

    const detail = await repo.getQualityIssue({ companyId: companyA, publicId });
    expect(detail.qualityIssue).toMatchObject({ conversation: null, excerpt: [] });

    const draft = await repo.draftQualityTest(
      { companyId: companyA, publicId },
      { waitUntil: () => undefined },
    );
    expect(draft.failure).toBe(Schemas.QualityTestDraftFailureEnum.NoConversation);

    const converted = await repo.convertQualityIssue({
      companyId: companyA,
      adminId: adminAId,
      publicId,
      draft: {
        name: "Not a test",
        messages: [{ role: Schemas.EvalCaseMessageRoleEnum.User, text: "Hi" }],
        rubric: "Greets",
      },
    });
    expect(converted.failure).toBe(Schemas.QualityIssueUpdateFailureEnum.NoConversation);
    expect((await healthIssues(chatbot.id))[0]?.status).toBe(
      Schemas.QualityIssueStatusIntEnum.Open,
    );

    // DEV_NOTE: Another company never sees it
    const foreign = await repo.getQualityIssue({ companyId: companyB, publicId });
    expect(foreign.isNotFound).toBe(true);
  });
});

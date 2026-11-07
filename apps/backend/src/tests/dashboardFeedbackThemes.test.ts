import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  admins,
  chatbotUsers,
  chatbots,
  companies,
  conversations,
  eventOutbox,
  feedbackNotes,
  feedbackThemes,
  qualityIssues,
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

// DEV_NOTE: Quality › User feedback (M7-10): the themes list with its counts, one theme's notes, Resolve and Dismiss (Open
// only, audited, closing the theme's Quality item). Tests hit the Neon staging branch through the whole worker (Repos as
// diletta_app, so RLS applies); fixtures and cleanup run as the owner. afterAll deletes every row this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const operator = `user_op_${crypto.randomUUID()}`;
const adminA = `user_a_${crypto.randomUUID()}`;
const adminB = `user_b_${crypto.randomUUID()}`;
const { Up, Down } = Schemas.FeedbackRatingIntEnum;
const { Open, Resolved, Dismissed } = Schemas.FeedbackThemeStatusIntEnum;
const vector = () => Array.from({ length: 1024 }, () => 0.5);

let companyA = "";
let companyB = "";
let bigTheme = "";
let smallTheme = "";
let likedTheme = "";
let resolvedTheme = "";
let otherCompanyTheme = "";
let bigThemeIssue = "";
let conversationPublicId = "";

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function call<T>(
  method: string,
  path: string,
  options: { as?: string } = {},
): Promise<{ status: number; body: T & Schemas.ApiResponse }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.as) headers["Authorization"] = `Bearer ${options.as}`;
  const request = new Request(`http://localhost${path}`, { method, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as T & Schemas.ApiResponse };
}

const themes = (query = "", as = adminA) =>
  call<Schemas.GetFeedbackThemesApiResponse>(
    "GET",
    `/dashboard/feedback-themes${query ? `?${query}` : ""}`,
    { as },
  );
const theme = (publicId: string, as = adminA) =>
  call<Schemas.GetFeedbackThemeApiResponse>("GET", `/dashboard/feedback-themes/${publicId}`, {
    as,
  });
const close = (publicId: string, action: "resolve" | "dismiss", as = adminA) =>
  call<Schemas.UpdateFeedbackThemeApiResponse>(
    "POST",
    `/dashboard/feedback-themes/${publicId}/${action}`,
    { as },
  );

const statusOf = async (publicId: string) =>
  await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ status: feedbackThemes.status })
      .from(feedbackThemes)
      .where(eq(feedbackThemes.publicId, publicId));
    return row?.status;
  });

const auditEvents = async () =>
  await withOwnerDb(async (ownerDb) => {
    const conditions = [
      eq(activityLog.companyId, companyA),
      eq(activityLog.entityType, Schemas.AuditEntityTypeEnum.FeedbackTheme),
    ];
    return await ownerDb
      .select({ actorType: activityLog.actorType, entityAction: activityLog.entityAction })
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id));
  });

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Feedback A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Feedback B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    await ownerDb.insert(admins).values([
      { clerkUserId: operator, companyId: null },
      { clerkUserId: adminA, companyId: companyA },
      { clerkUserId: adminB, companyId: companyB },
    ]);
    const [bot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId: companyA, name: "Support" })
      .returning({ id: chatbots.id });
    const [otherBot] = await ownerDb
      .insert(chatbots)
      .values({ publicId: Utility.generatePublicId(), companyId: companyB, name: "Other" })
      .returning({ id: chatbots.id });
    const users = await ownerDb
      .insert(chatbotUsers)
      .values([
        { companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` },
        { companyId: companyA, hostUserId: `host_${crypto.randomUUID()}` },
      ])
      .returning({ id: chatbotUsers.id });
    const [conversation] = await ownerDb
      .insert(conversations)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        chatbotUserId: users[0]!.id,
        chatbotId: bot!.id,
      })
      .returning({ id: conversations.id, publicId: conversations.publicId });
    conversationPublicId = conversation!.publicId;

    const themeRow = (
      companyId: string,
      chatbotId: string,
      rating: Schemas.FeedbackRatingIntEnum,
      label: string,
      noteCount: number,
      status: Schemas.FeedbackThemeStatusIntEnum = Open,
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      chatbotId,
      rating,
      label,
      centroid: vector(),
      noteCount,
      status,
    });
    const rows = await ownerDb
      .insert(feedbackThemes)
      .values([
        themeRow(companyA, bot!.id, Down, "Answers quote the old fire drill schedule", 3),
        themeRow(companyA, bot!.id, Down, "Replies are too long", 1),
        themeRow(companyA, bot!.id, Up, "Quick, correct answers", 2),
        themeRow(companyA, bot!.id, Down, "Dates shown month first", 1, Resolved),
        themeRow(companyB, otherBot!.id, Down, "Other company theme", 1),
      ])
      .returning({ id: feedbackThemes.id, publicId: feedbackThemes.publicId });
    [bigTheme, smallTheme, likedTheme, resolvedTheme, otherCompanyTheme] = rows.map(
      (row) => row.publicId,
    );
    const bigThemeId = rows[0]!.id;

    const note = (chatbotUserId: string, summary: string, minutesAgo: number) => ({
      publicId: Utility.generatePublicId(),
      companyId: companyA,
      chatbotId: bot!.id,
      feedbackId: String(Math.floor(Math.random() * 1e15) + 1e15),
      conversationId: conversation!.id,
      chatbotUserId,
      rating: Down,
      commentVersion: 1,
      summary,
      themeId: bigThemeId,
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    });
    await ownerDb
      .insert(feedbackNotes)
      .values([
        note(users[0]!.id, "Drills are every 6 months in the answer", 30),
        note(users[1]!.id, "The July policy update wasn't used", 20),
        note(users[1]!.id, "The policy changed to quarterly", 10),
      ]);

    const [issue] = await ownerDb
      .insert(qualityIssues)
      .values({
        publicId: Utility.generatePublicId(),
        companyId: companyA,
        chatbotId: bot!.id,
        conversationId: null,
        source: Schemas.QualityIssueSourceIntEnum.System,
        issueType: Schemas.QualityIssueTypeIntEnum.FeedbackTheme,
        note: Schemas.feedbackThemeQualityNote("Answers quote the old fire drill schedule"),
        feedbackThemeId: bigThemeId,
      })
      .returning({ publicId: qualityIssues.publicId });
    bigThemeIssue = issue!.publicId;
  });
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(qualityIssues).where(inArray(qualityIssues.companyId, companyIds));
    await ownerDb.delete(feedbackNotes).where(inArray(feedbackNotes.companyId, companyIds));
    await ownerDb.delete(feedbackThemes).where(inArray(feedbackThemes.companyId, companyIds));
    await ownerDb.delete(conversations).where(inArray(conversations.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, [operator, adminA, adminB]));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("/dashboard/feedback-themes", () => {
  it("answers 401 signed out and 403 to an operator", async () => {
    expect((await call("GET", "/dashboard/feedback-themes")).status).toBe(401);
    expect((await themes("", operator)).status).toBe(403);
    expect((await close(bigTheme, "resolve", operator)).status).toBe(403);
  });

  it("lists open Didn't like themes, most notes first, with every count and no internal ids", async () => {
    const listed = await themes();
    expect(listed.status).toBe(200);
    expect(listed.body.tabCounts).toEqual({ open: 2, resolved: 1, dismissed: 0 });
    expect(listed.body.ratingCounts).toEqual({ disliked: 2, liked: 1 });
    expect(listed.body.totalRecords).toBe(2);
    const rows = listed.body.feedbackThemes ?? [];
    expect(rows.map((row) => row.publicId)).toEqual([bigTheme, smallTheme]);
    expect(rows[0]).toMatchObject({
      label: "Answers quote the old fire drill schedule",
      rating: Down,
      ratingLabel: Schemas.FeedbackRatingLabelEnum.Down,
      feedbackThemeStatus: Open,
      feedbackThemeStatusLabel: Schemas.FeedbackThemeStatusLabelEnum.Open,
      noteCount: 3,
      userCount: 2,
      latestSummary: "The policy changed to quarterly",
      qualityIssuePublicId: bigThemeIssue,
      chatbotName: "Support",
    });
    expect(rows[1]).toMatchObject({ userCount: 0, latestSummary: null, latestNoteAt: null });
    expect(JSON.stringify(listed.body)).not.toMatch(/"(id|companyId|chatbotId|themeId)"/);

    const liked = await themes("rating=liked");
    expect(liked.body.feedbackThemes?.map((row) => row.publicId)).toEqual([likedTheme]);
    const resolved = await themes("tab=resolved");
    expect(resolved.body.feedbackThemes?.map((row) => row.publicId)).toEqual([resolvedTheme]);
  });

  it("reads one theme with its newest notes and their conversations", async () => {
    const read = await theme(bigTheme);
    expect(read.status).toBe(200);
    expect(read.body.feedbackTheme?.notes.map((note) => note.summary)).toEqual([
      "The policy changed to quarterly",
      "The July policy update wasn't used",
      "Drills are every 6 months in the answer",
    ]);
    expect(read.body.feedbackTheme?.notes[0]?.conversationPublicId).toBe(conversationPublicId);
    expect((await theme("missing")).status).toBe(404);
  });

  it("shows another company only its own (RLS, diletta_app)", async () => {
    const listed = await themes("", adminB);
    expect(listed.body.feedbackThemes?.map((row) => row.publicId)).toEqual([otherCompanyTheme]);
    expect((await theme(bigTheme, adminB)).status).toBe(404);
    expect((await close(bigTheme, "resolve", adminB)).status).toBe(404);
    expect(await statusOf(bigTheme)).toBe(Open);
  });

  it("resolves an Open theme once, closing its Quality item as Fixed, audited", async () => {
    const resolved = await close(bigTheme, "resolve");
    expect(resolved.status).toBe(200);
    expect(resolved.body.feedbackTheme).toMatchObject({
      publicId: bigTheme,
      feedbackThemeStatus: Resolved,
    });
    expect(resolved.body.feedbackTheme?.notes).toHaveLength(3);
    const [issue] = await withOwnerDb(async (ownerDb) => {
      return await ownerDb
        .select({ status: qualityIssues.status })
        .from(qualityIssues)
        .where(eq(qualityIssues.publicId, bigThemeIssue));
    });
    expect(issue?.status).toBe(Schemas.QualityIssueStatusIntEnum.Fixed);

    const again = await close(bigTheme, "dismiss");
    expect(again.status).toBe(409);
    expect(again.body.failure).toBe(Schemas.FeedbackThemeUpdateFailureEnum.NotOpen);
    expect((await close(resolvedTheme, "resolve")).status).toBe(409);
    expect((await close("missing", "resolve")).status).toBe(404);
  });

  it("dismisses an Open theme once", async () => {
    const dismissed = await close(smallTheme, "dismiss");
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.feedbackTheme?.feedbackThemeStatus).toBe(Dismissed);
    expect(await statusOf(smallTheme)).toBe(Dismissed);

    // DEV_NOTE: One audit row per close (M4-9), none for the refusals
    expect((await auditEvents()).map((event) => [event.actorType, event.entityAction])).toEqual([
      [Schemas.ActivityLogActorTypeIntEnum.Admin, Schemas.AuditEntityActionEnum.Resolved],
      [Schemas.ActivityLogActorTypeIntEnum.Admin, Schemas.AuditEntityActionEnum.Dismissed],
    ]);
  });
});

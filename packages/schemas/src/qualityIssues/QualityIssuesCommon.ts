import { z } from "zod";
import { DOC_GAP_EMAIL, DOC_GAP_LONG_NUMBER } from "../docGaps/DocGapsCommon";
import { EvalCaseMessageRoleEnum, ZEvalCaseDraft } from "../evalCases";

export enum QualityIssueSourceIntEnum {
  User = 1,
  Admin = 2,
  System = 3,
}

export enum QualityIssueSourceLabelEnum {
  User = "User",
  Admin = "Admin",
  System = "System",
}

export const QUALITY_ISSUE_SOURCE_LABEL_MAP: Record<
  QualityIssueSourceIntEnum,
  QualityIssueSourceLabelEnum
> = {
  [QualityIssueSourceIntEnum.User]: QualityIssueSourceLabelEnum.User,
  [QualityIssueSourceIntEnum.Admin]: QualityIssueSourceLabelEnum.Admin,
  [QualityIssueSourceIntEnum.System]: QualityIssueSourceLabelEnum.System,
};

export enum QualityIssueStatusIntEnum {
  Open = 1,
  Dismissed = 2,
  Converted = 3,
  Fixed = 4,
}

export enum QualityIssueStatusLabelEnum {
  Open = "Open",
  Dismissed = "Dismissed",
  Converted = "Converted",
  Fixed = "Fixed",
}

export const QUALITY_ISSUE_STATUS_LABEL_MAP: Record<
  QualityIssueStatusIntEnum,
  QualityIssueStatusLabelEnum
> = {
  [QualityIssueStatusIntEnum.Open]: QualityIssueStatusLabelEnum.Open,
  [QualityIssueStatusIntEnum.Dismissed]: QualityIssueStatusLabelEnum.Dismissed,
  [QualityIssueStatusIntEnum.Converted]: QualityIssueStatusLabelEnum.Converted,
  [QualityIssueStatusIntEnum.Fixed]: QualityIssueStatusLabelEnum.Fixed,
};

export enum QualityIssueTypeIntEnum {
  KnowledgeGap = 1,
  MissingTool = 2,
  ToolBug = 3,
  ModelError = 4,
  Injection = 5,
  HealthDrop = 6,
}

export enum QualityIssueTypeLabelEnum {
  KnowledgeGap = "Knowledge gap",
  MissingTool = "Missing tool",
  ToolBug = "Tool bug",
  ModelError = "Model error",
  Injection = "Prompt injection",
  HealthDrop = "Health drop",
}

export const QUALITY_ISSUE_TYPE_LABEL_MAP: Record<
  QualityIssueTypeIntEnum,
  QualityIssueTypeLabelEnum
> = {
  [QualityIssueTypeIntEnum.KnowledgeGap]: QualityIssueTypeLabelEnum.KnowledgeGap,
  [QualityIssueTypeIntEnum.MissingTool]: QualityIssueTypeLabelEnum.MissingTool,
  [QualityIssueTypeIntEnum.ToolBug]: QualityIssueTypeLabelEnum.ToolBug,
  [QualityIssueTypeIntEnum.ModelError]: QualityIssueTypeLabelEnum.ModelError,
  [QualityIssueTypeIntEnum.Injection]: QualityIssueTypeLabelEnum.Injection,
  [QualityIssueTypeIntEnum.HealthDrop]: QualityIssueTypeLabelEnum.HealthDrop,
};

// DEV_NOTE: The activity_log / event_outbox names of quality issue events, shared by every writer (ModelKeyFailureProvider,
// UserQualityIssueProvider) so an event type or dedupe key is spelled once: the dedupe key is what makes a repeat a no-op.
export const QUALITY_ISSUE_ENTITY_TYPE = "quality_issue";

export enum QualityIssueEntityActionEnum {
  Opened = "opened",
  ProviderAdded = "provider_added",
  // DEV_NOTE: The daily health check (M5-5) found another day's drop while the chatbot's Health drop issue is open
  HealthDropAdded = "health_drop_added",
  // DEV_NOTE: An admin's work on the Quality page (M4-6): the type and note set, closed as fixed or dismissed, or
  // turned into a test
  Triaged = "triaged",
  Fixed = "fixed",
  Dismissed = "dismissed",
  Converted = "converted",
  // DEV_NOTE: Doc gaps (M5-6), the one way an item leaves a closed status: its group reopened, its document removed
  Reopened = "reopened",
}

export const qualityIssueEventType = (action: QualityIssueEntityActionEnum): string =>
  `${QUALITY_ISSUE_ENTITY_TYPE}.${action}`;

// DEV_NOTE: <event type>:<issue publicId>[:<part>…], e.g. quality_issue.provider_added:<publicId>:<provider>
export const qualityIssueEventDedupeKey = (
  action: QualityIssueEntityActionEnum,
  qualityIssuePublicId: string,
  ...parts: string[]
): string => [qualityIssueEventType(action), qualityIssuePublicId, ...parts].join(":");

// Whole Quality Issue Body — DB shape (enums stored as integers)
// DEV_NOTE: id, companyId, chatbotId, conversationId, changeRequestId, feedbackId, evalCaseId, createdBy and updatedBy
// are internal bigint ids — used by DAL/Repo only, NEVER sent to a client. CHECKs tie feedbackId to source = User,
// createdBy to source = Admin, evalCaseId to status = Converted, and a missing conversation to source = System (a
// chatbot-wide issue such as a health drop, M5-5, which always names its chatbot). chatbotId = the conversation's
// chatbot, or the chatbot a chatbot-wide issue is about; every write sets it (null only on an issue older than M5-5 whose
// conversation row is gone).
export const ZQualityIssue = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string().nullable(),
  conversationId: z.string().nullable(),
  changeRequestId: z.string().nullable(),
  feedbackId: z.string().nullable(),
  source: z.enum(QualityIssueSourceIntEnum),
  status: z.enum(QualityIssueStatusIntEnum),
  issueType: z.enum(QualityIssueTypeIntEnum).nullable(),
  note: z.string().nullable(),
  evalCaseId: z.string().nullable(),
  docGapClusterId: z.string().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type QualityIssue = z.infer<typeof ZQualityIssue>;

// DEV_NOTE: The Quality page's tabs (M4-6), one status each. Every action on an issue starts from Open and ends it for
// good (no reopen): Mark fixed → Fixed, Dismiss → Dismissed, Create test → Converted.
export enum QualityIssueListTabEnum {
  Open = "open",
  Converted = "converted",
  Fixed = "fixed",
  Dismissed = "dismissed",
}

export const ZQualityIssueListTab = z.enum(QualityIssueListTabEnum);

// DEV_NOTE: The count behind each tab, keyed by the tab itself, under the same chatbot filter
export type QualityIssueTabCounts = Record<QualityIssueListTabEnum, number>;

export const QUALITY_ISSUE_TAB_STATUS: Record<QualityIssueListTabEnum, QualityIssueStatusIntEnum> =
  {
    [QualityIssueListTabEnum.Open]: QualityIssueStatusIntEnum.Open,
    [QualityIssueListTabEnum.Converted]: QualityIssueStatusIntEnum.Converted,
    [QualityIssueListTabEnum.Fixed]: QualityIssueStatusIntEnum.Fixed,
    [QualityIssueListTabEnum.Dismissed]: QualityIssueStatusIntEnum.Dismissed,
  };

export enum QualityIssueSortColumn {
  CreatedAt = "createdAt",
  UpdatedAt = "updatedAt",
}

export const ZQualityIssueSortColumn = z.enum(QualityIssueSortColumn);

// DEV_NOTE: The Quality page's rows per page (the API's own default page size is smaller)
export const QUALITY_PAGE_SIZE = 25;

// DEV_NOTE: An admin's note on an issue (free text, never logged), and how much of a rated reply the list shows
export const QUALITY_ISSUE_NOTE_MAX_CHARS = 2000;
export const QUALITY_ISSUE_EXCERPT_MAX_CHARS = 280;

// DEV_NOTE: The most text a test rewrite is sent (its messages together, newest kept) and the reply that went wrong.
// The model restates the messages in its answer, which must fit MODEL_CALL_MAX_OUTPUT_TOKENS (8192, ~30k chars) and a
// budget-shortened hold, so the input stays well under it.
export const QUALITY_TEST_REWRITE_MAX_CHARS = 12_000;
export const QUALITY_TEST_REWRITE_REPLY_MAX_CHARS = 2_000;

// DEV_NOTE: The ways out of Open that an admin picks on the detail card (Create test has its own request)
export type QualityIssueCloseStatus =
  | QualityIssueStatusIntEnum.Fixed
  | QualityIssueStatusIntEnum.Dismissed;

export const QUALITY_ISSUE_CLOSE_ENTITY_ACTION_MAP: Record<
  QualityIssueCloseStatus,
  QualityIssueEntityActionEnum
> = {
  [QualityIssueStatusIntEnum.Fixed]: QualityIssueEntityActionEnum.Fixed,
  [QualityIssueStatusIntEnum.Dismissed]: QualityIssueEntityActionEnum.Dismissed,
};

// DEV_NOTE: Why a triage, close or convert changed nothing (409): the issue is no longer Open (someone closed or
// converted it first), or (convert) its chatbot is gone
export enum QualityIssueUpdateFailureEnum {
  NotOpen = "NotOpen",
  // DEV_NOTE: Convert only: the conversation's chatbot was removed, so there is no chatbot to own the test
  ChatbotNotFound = "ChatbotNotFound",
  // DEV_NOTE: Convert only: a chatbot-wide system issue (a health drop, M5-5) has no conversation to turn into a test
  NoConversation = "NoConversation",
  // DEV_NOTE: Convert only (M5-7): the reviewed test still holds a personal detail the admin didn't confirm
  PersonalDetailsFound = "PersonalDetailsFound",
}

// DEV_NOTE: Why Create test produced no draft. NotOpen: the issue was closed meanwhile. NoConversation: the chat has
// no question left to test (purged, or no user message). NoPublishedConfig: the chatbot can't route a model yet.
// ModelUnavailable: the model router refused (no key, budget, provider down). RewriteFailed: the model's answer
// wasn't a usable draft.
export enum QualityTestDraftFailureEnum {
  NotOpen = "NotOpen",
  NoConversation = "NoConversation",
  NoPublishedConfig = "NoPublishedConfig",
  ModelUnavailable = "ModelUnavailable",
  RewriteFailed = "RewriteFailed",
}

export const QUALITY_TEST_DRAFT_FAILURE_HTTP_STATUS_MAP: Record<
  QualityTestDraftFailureEnum,
  409 | 502 | 503
> = {
  [QualityTestDraftFailureEnum.NotOpen]: 409,
  [QualityTestDraftFailureEnum.NoConversation]: 409,
  [QualityTestDraftFailureEnum.NoPublishedConfig]: 409,
  [QualityTestDraftFailureEnum.ModelUnavailable]: 503,
  [QualityTestDraftFailureEnum.RewriteFailed]: 502,
};

// DEV_NOTE: A test made from an issue (M4-6): the model's rewrite of the chat without personal details, which the admin
// reviews and edits before saving (POST …/convert takes it back as edited). The same shape as a case written on the Tests
// page (M4-8).
export const ZQualityTestDraft = ZEvalCaseDraft;
export type QualityTestDraft = z.infer<typeof ZQualityTestDraft>;

// DEV_NOTE: What the rewrite model is asked to return (structured output). Plain types only, since it becomes the JSON
// Schema the provider sees; the answer is then held to ZQualityTestDraft (QualityTestRewriteProvider.parse).
export const ZQualityTestRewriteOutput = z.object({
  name: z
    .string()
    .describe("A short name for the test: what the user asks, with no personal details"),
  messages: z
    .array(
      z.object({
        role: z.enum(EvalCaseMessageRoleEnum),
        text: z.string(),
      }),
    )
    .describe(
      "The conversation rewritten without personal details, oldest first, ending with the user's question",
    ),
  rubric: z
    .string()
    .describe("What a good reply to the last question must do and must not do, as short criteria"),
});

// DEV_NOTE: What the name check asks of its model (M5-7). Plain types only, as above.
export const ZQualityTestCheckOutput = z.object({
  names: z
    .array(z.string())
    .describe("Every name of a real person, written exactly as it appears in the test"),
});

export const QUALITY_TEST_TERM_MAX_CHARS = 200;
export const QUALITY_TEST_CONFIRMED_TERMS_MAX = 100;

// DEV_NOTE: A term the review must deal with. canConfirm false = always personal (the chat user's name, an email, a long
// number): it can only be edited out. true = may be a product word: the admin edits it out or confirms it isn't personal.
export interface QualityTestFlaggedTerm {
  term: string;
  canConfirm: boolean;
}

// DEV_NOTE: The review as the dialog holds it. wasVerified false = the name check's model call didn't run.
export interface QualityTestReview {
  draft: QualityTestDraft;
  flaggedTerms: QualityTestFlaggedTerm[];
  wasVerified: boolean;
}

// DEV_NOTE: A capitalised word that doesn't open a sentence, so it reads as a name. All-caps words, "I'm" and calendar
// words are left out: they are what a chat is full of and never a person.
const QUALITY_TEST_NAME_LIKE_WORD =
  /(?<![\p{L}\p{N}'’-])(?<![.!?…:;\n"“(]\s*)(?<!^\s*)\p{Lu}\p{L}*(?:['’-]\p{L}+)*/gu;
const QUALITY_TEST_FIRST_PERSON = /^I['’]/;
const QUALITY_TEST_CALENDAR_WORDS = new Set(
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);
const QUALITY_TEST_USER_NAME_PART_MIN_CHARS = 2;

function qualityTestDraftText(draft: QualityTestDraft): string {
  return [draft.name, ...draft.messages.map((message) => message.text), draft.rubric].join("\n");
}

// DEV_NOTE: Whole word: "Priya" is never found in "Priyanka"
function qualityTestTermPattern(term: string, flags: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, flags);
}

// DEV_NOTE: In any case: a name the rewrite lowercased is still that name
export function qualityTestDraftHasTerm(draft: QualityTestDraft, term: string): boolean {
  return qualityTestTermPattern(term, "iu").test(qualityTestDraftText(draft));
}

function qualityTestNameLikeWords(text: string): string[] {
  return Array.from(text.matchAll(QUALITY_TEST_NAME_LIKE_WORD), (match) => match[0]).filter(
    (word) =>
      word !== word.toUpperCase() &&
      !QUALITY_TEST_FIRST_PERSON.test(word) &&
      !QUALITY_TEST_CALENDAR_WORDS.has(word.toLowerCase()),
  );
}

// DEV_NOTE: The check Create test's draft and save both run (M5-7), pure: the test against what it was made from. Blocked
// outright: an email or long number anywhere in it, a part of the chat user's name. For the admin to judge: a name-like
// word of the chat or note that the test repeats. A name opening a sentence or written in lowercase isn't seen here; the
// model's check at draft flags those.
export function findQualityTestPersonalDetails(params: {
  draft: QualityTestDraft;
  sourceTexts: string[];
  userName: string | null;
}): QualityTestFlaggedTerm[] {
  const { draft, sourceTexts, userName } = params;
  const text = qualityTestDraftText(draft);
  const found = new Map<string, QualityTestFlaggedTerm>();
  const add = (term: string, canConfirm: boolean) => {
    const key = term.toLowerCase();
    if (!found.has(key)) found.set(key, { term, canConfirm });
  };

  for (const pattern of [DOC_GAP_EMAIL, DOC_GAP_LONG_NUMBER]) {
    for (const match of text.matchAll(new RegExp(pattern.source, "g"))) add(match[0], false);
  }
  for (const part of userName?.split(/\s+/) ?? []) {
    if (
      part.length >= QUALITY_TEST_USER_NAME_PART_MIN_CHARS &&
      qualityTestDraftHasTerm(draft, part)
    ) {
      add(part, false);
    }
  }
  // DEV_NOTE: A word the chat also writes in lowercase is an ordinary word ("the Fire policy", "fire drills")
  const source = sourceTexts.join("\n");
  for (const word of sourceTexts.flatMap(qualityTestNameLikeWords)) {
    if (qualityTestTermPattern(word.toLowerCase(), "u").test(source)) continue;
    if (qualityTestDraftHasTerm(draft, word)) add(word, true);
  }
  return [...found.values()];
}

// DEV_NOTE: The name check's answer added to the flagged terms: only what the test really holds, each for the admin to
// judge
export function withQualityTestCheckedNames(
  flagged: QualityTestFlaggedTerm[],
  draft: QualityTestDraft,
  names: string[],
): QualityTestFlaggedTerm[] {
  const seen = new Set(flagged.map(({ term }) => term.toLowerCase()));
  const added: QualityTestFlaggedTerm[] = [];
  for (const name of names.map((value) => value.trim())) {
    if (name.length < QUALITY_TEST_USER_NAME_PART_MIN_CHARS) continue;
    if (name.length > QUALITY_TEST_TERM_MAX_CHARS || seen.has(name.toLowerCase())) continue;
    if (!qualityTestDraftHasTerm(draft, name)) continue;
    seen.add(name.toLowerCase());
    added.push({ term: name, canConfirm: true });
  }
  return [...flagged, ...added];
}

// DEV_NOTE: What still stops a save: a term that can't be confirmed, or one the admin didn't
export function unconfirmedQualityTestTerms(
  flagged: QualityTestFlaggedTerm[],
  confirmedTerms: string[],
): QualityTestFlaggedTerm[] {
  const confirmed = new Set(confirmedTerms.map((term) => term.toLowerCase()));
  return flagged.filter(
    ({ term, canConfirm }) => !canConfirm || !confirmed.has(term.toLowerCase()),
  );
}

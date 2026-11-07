import { z } from "zod";
import { FeedbackRatingIntEnum } from "../feedback/FeedbackCommon";
import { hasPersonalDetailPattern } from "../personalDetails/PersonalDetailsCommon";

// DEV_NOTE: Feedback themes (M7-10): visitors' notes on their ratings, read by a model on the company's key (a short
// summary with no personal details), embedded, and grouped per chatbot and per thumb. A Didn't like theme that keeps
// growing opens one Quality item. Mirrors doc gaps (M5-6).

// DEV_NOTE: Status Enum Pattern. Open: growing, shown first. Resolved: an admin says the chatbot answers better now; never
// joined again, so the same complaint coming back starts a new theme. Dismissed: not worth acting on; still grows
// silently, so it doesn't come back as a new theme.
export enum FeedbackThemeStatusIntEnum {
  Open = 1,
  Resolved = 2,
  Dismissed = 3,
}

export enum FeedbackThemeStatusLabelEnum {
  Open = "Open",
  Resolved = "Resolved",
  Dismissed = "Dismissed",
}

export const FEEDBACK_THEME_STATUS_LABEL_MAP: Record<
  FeedbackThemeStatusIntEnum,
  FeedbackThemeStatusLabelEnum
> = {
  [FeedbackThemeStatusIntEnum.Open]: FeedbackThemeStatusLabelEnum.Open,
  [FeedbackThemeStatusIntEnum.Resolved]: FeedbackThemeStatusLabelEnum.Resolved,
  [FeedbackThemeStatusIntEnum.Dismissed]: FeedbackThemeStatusLabelEnum.Dismissed,
};

// DEV_NOTE: One theme. id, companyId and chatbotId are internal — NEVER sent to a client. rating is the thumb its notes
// were left on (a theme never mixes them). label is its first note's summary. noteCount counts the notes in it now (a
// note edited or cleared leaves). The centroid is the clustering's own and stays out of this type.
export const ZFeedbackTheme = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string(),
  rating: z.enum(FeedbackRatingIntEnum),
  label: z.string(),
  noteCount: z.number().int(),
  status: z.enum(FeedbackThemeStatusIntEnum),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FeedbackTheme = z.infer<typeof ZFeedbackTheme>;

// DEV_NOTE: One note as the clustering read it (internal only; the themes pages read summaries through their theme).
// One per feedback row (UNQ_feedback_notes_feedback_id): an edited note replaces it. commentVersion is the
// feedback.comment_version it summarises, so a stale event never overwrites a newer note. themeId null = pending: its
// summary is stored, its embedding and theme aren't yet, so a retry never pays for the rewrite again.
export const ZFeedbackNote = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string(),
  feedbackId: z.string(),
  conversationId: z.string(),
  chatbotUserId: z.string(),
  rating: z.enum(FeedbackRatingIntEnum),
  commentVersion: z.number().int(),
  summary: z.string(),
  themeId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FeedbackNote = z.infer<typeof ZFeedbackNote>;

// DEV_NOTE: How close a note must be to a theme's centroid to join it (cosine similarity on bge-m3), and when a Didn't
// like theme opens its one Quality item: this many notes from this many different users (the doc gap floors)
export const FEEDBACK_THEME_MIN_SIMILARITY = 0.85;
export const FEEDBACK_THEME_QUALITY_MIN_NOTES = 5;
export const FEEDBACK_THEME_QUALITY_MIN_USERS = 3;
// DEV_NOTE: A summary's size
export const FEEDBACK_NOTE_SUMMARY_MAX_CHARS = 300;

// DEV_NOTE: The critical event a stored note writes (FeedbackRepo.recordFeedbackNote), and the queue consumer's cue.
// Ids only: the note's text never rides in an event. One per note version, so an edit is read again.
export const FEEDBACK_NOTE_ADDED_EVENT_TYPE = "feedback.note_added";
export const FEEDBACK_NOTE_ENTITY_TYPE = "feedback";
export const FEEDBACK_NOTE_ENTITY_ACTION = "note_added";

export function feedbackNoteAddedDedupeKey(
  feedbackPublicId: string,
  commentVersion: number,
): string {
  return `${FEEDBACK_NOTE_ADDED_EVENT_TYPE}:${feedbackPublicId}:${commentVersion}`;
}

export const ZFeedbackNoteAddedDetail = z.object({
  feedbackId: z.string().min(1),
  commentVersion: z.number().int().min(1),
});
export type FeedbackNoteAddedDetail = z.infer<typeof ZFeedbackNoteAddedDetail>;

// DEV_NOTE: The rewrite's structured answer: isSpecific false for a note that says nothing to act on ("thanks", "ok",
// "great"); summaryGeneric is then empty (always present: providers refuse optional fields in some structured modes)
export const ZFeedbackNoteRewriteOutput = z.object({
  isSpecific: z.boolean(),
  summaryGeneric: z.string(),
});
export type FeedbackNoteRewriteOutput = z.infer<typeof ZFeedbackNoteRewriteOutput>;

// DEV_NOTE: Server-side only — what the rewrite reads: the note, the thumb it came with, and the reply it was about
export interface FeedbackNoteRewriteSource {
  note: string;
  rating: FeedbackRatingIntEnum;
  reply: string;
}

// DEV_NOTE: The rewrite's answer held to what may be stored. null = nothing to group (not specific, empty, too long, or
// still holding an email or a long number: the backstop behind the instructions, as for doc gaps).
export function parseFeedbackNoteRewrite(output: FeedbackNoteRewriteOutput): string | null {
  if (!output.isSpecific) return null;
  const summary = output.summaryGeneric.trim();
  if (summary.length === 0 || summary.length > FEEDBACK_NOTE_SUMMARY_MAX_CHARS) return null;
  return hasPersonalDetailPattern(summary) ? null : summary;
}

// DEV_NOTE: A theme's centroid after one more note: the running mean over its notes. A note that leaves doesn't move
// it back (the centroid only steers which theme a new note joins).
export function nextFeedbackThemeCentroid(
  centroid: number[],
  noteCount: number,
  embedding: number[],
): number[] {
  return centroid.map(
    (value, index) => (value * noteCount + (embedding[index] ?? 0)) / (noteCount + 1),
  );
}

// DEV_NOTE: Whether a theme opens its Quality item now: only an Open Didn't like theme, only once over both floors
export function feedbackThemeOpensQualityIssue(params: {
  rating: FeedbackRatingIntEnum;
  isOpen: boolean;
  noteCount: number;
  userCount: number;
}): boolean {
  return (
    params.rating === FeedbackRatingIntEnum.Down &&
    params.isOpen &&
    params.noteCount >= FEEDBACK_THEME_QUALITY_MIN_NOTES &&
    params.userCount >= FEEDBACK_THEME_QUALITY_MIN_USERS
  );
}

export function feedbackThemeQualityNote(label: string): string {
  return `Several people rated replies not helpful for the same reason: "${label}". See their notes under User feedback.`;
}

// DEV_NOTE: The User feedback view's tabs (M7-10), one status each, and its thumb filter. An admin resolves or dismisses
// an Open theme; neither is reopened by hand.
export enum FeedbackThemeListTabEnum {
  Open = "open",
  Resolved = "resolved",
  Dismissed = "dismissed",
}

export const ZFeedbackThemeListTab = z.enum(FeedbackThemeListTabEnum);

export type FeedbackThemeTabCounts = Record<FeedbackThemeListTabEnum, number>;

export const FEEDBACK_THEME_TAB_STATUS: Record<
  FeedbackThemeListTabEnum,
  FeedbackThemeStatusIntEnum
> = {
  [FeedbackThemeListTabEnum.Open]: FeedbackThemeStatusIntEnum.Open,
  [FeedbackThemeListTabEnum.Resolved]: FeedbackThemeStatusIntEnum.Resolved,
  [FeedbackThemeListTabEnum.Dismissed]: FeedbackThemeStatusIntEnum.Dismissed,
};

export enum FeedbackThemeRatingFilterEnum {
  Disliked = "disliked",
  Liked = "liked",
}

export const ZFeedbackThemeRatingFilter = z.enum(FeedbackThemeRatingFilterEnum);

export type FeedbackThemeRatingCounts = Record<FeedbackThemeRatingFilterEnum, number>;

export const FEEDBACK_THEME_RATING_FILTER_RATING: Record<
  FeedbackThemeRatingFilterEnum,
  FeedbackRatingIntEnum
> = {
  [FeedbackThemeRatingFilterEnum.Disliked]: FeedbackRatingIntEnum.Down,
  [FeedbackThemeRatingFilterEnum.Liked]: FeedbackRatingIntEnum.Up,
};

// DEV_NOTE: Most notes first by default
export enum FeedbackThemeSortColumn {
  NoteCount = "noteCount",
  CreatedAt = "createdAt",
  UpdatedAt = "updatedAt",
}

export const ZFeedbackThemeSortColumn = z.enum(FeedbackThemeSortColumn);

// DEV_NOTE: Rows per page, and how many of a theme's notes its detail reads (the newest)
export const FEEDBACK_THEMES_PAGE_SIZE = 20;
export const FEEDBACK_THEME_NOTES_MAX = 50;

// DEV_NOTE: Why a resolve or dismiss changed nothing (409): the theme is no longer Open (someone closed it first)
export enum FeedbackThemeUpdateFailureEnum {
  NotOpen = "NotOpen",
}

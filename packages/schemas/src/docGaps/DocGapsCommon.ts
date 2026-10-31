import { z } from "zod";
import { SearchHelpDocsStatusEnum } from "../knowledgeSearch/KnowledgeSearchCommon";

export enum DocGapSignalIntEnum {
  LowRetrieval = 1,
  Idk = 2,
  Handoff = 3,
  ThumbsDown = 4,
  Admin = 5,
}

export enum DocGapSignalLabelEnum {
  LowRetrieval = "Low retrieval",
  Idk = "I don't know",
  Handoff = "Handoff",
  ThumbsDown = "Thumbs down",
  Admin = "Admin",
}

export const DOC_GAP_SIGNAL_LABEL_MAP: Record<DocGapSignalIntEnum, DocGapSignalLabelEnum> = {
  [DocGapSignalIntEnum.LowRetrieval]: DocGapSignalLabelEnum.LowRetrieval,
  [DocGapSignalIntEnum.Idk]: DocGapSignalLabelEnum.Idk,
  [DocGapSignalIntEnum.Handoff]: DocGapSignalLabelEnum.Handoff,
  [DocGapSignalIntEnum.ThumbsDown]: DocGapSignalLabelEnum.ThumbsDown,
  [DocGapSignalIntEnum.Admin]: DocGapSignalLabelEnum.Admin,
};

// Whole Doc Gap Body — DB shape (enums stored as integers)
// DEV_NOTE: Internal only: the Knowledge page reads a gap's question_generic through its group, never this row.
// conversationId and messageId go null at the chat purge (M6-1); the gap stays. embedding is the clustering's own.
export const ZDocGap = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  questionGeneric: z.string(),
  signal: z.enum(DocGapSignalIntEnum),
  clusterId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type DocGap = z.infer<typeof ZDocGap>;

// DEV_NOTE: How close a question must be to a group's centroid to join it (cosine similarity on bge-m3)
export const DOC_GAP_CLUSTER_MIN_SIMILARITY = 0.85;
// DEV_NOTE: When a group opens its one Quality item: this many questions, from this many conversations, so a single
// question never opens one and neither does one user asking again and again
export const DOC_GAP_QUALITY_MIN_QUESTIONS = 5;
export const DOC_GAP_QUALITY_MIN_CONVERSATIONS = 3;
// DEV_NOTE: A rewritten question's size, and how much of the chat the rewrite reads (each side)
export const DOC_GAP_QUESTION_MAX_CHARS = 300;
export const DOC_GAP_SOURCE_TEXT_MAX_CHARS = 4000;

// DEV_NOTE: The critical event recordTurn writes for a candidate, and the queue consumer's cue. Ids only: chat text
// never rides in an event. The verdict is the consumer's (DocGapsRepo).
export const DOC_GAP_CANDIDATE_EVENT_TYPE = "doc_gap.candidate";
export const DOC_GAP_CANDIDATE_ENTITY_TYPE = "message";
export const DOC_GAP_CANDIDATE_ENTITY_ACTION = "doc_gap_candidate";

export function docGapCandidateDedupeKey(messagePublicId: string): string {
  return `${DOC_GAP_CANDIDATE_EVENT_TYPE}:${messagePublicId}`;
}

export const ZDocGapCandidateDetail = z.object({
  messageId: z.string().min(1),
  conversationId: z.string().min(1),
  chatbotId: z.string().min(1),
  signal: z.enum(DocGapSignalIntEnum),
});
export type DocGapCandidateDetail = z.infer<typeof ZDocGapCandidateDetail>;

// DEV_NOTE: The rewrite's structured answer. questionGeneric is empty when wasUnanswered is false (providers refuse
// optional fields in some structured modes, so it is always present).
export const ZDocGapRewriteOutput = z.object({
  wasUnanswered: z.boolean(),
  questionGeneric: z.string(),
});
export type DocGapRewriteOutput = z.infer<typeof ZDocGapRewriteOutput>;

// DEV_NOTE: Server-side only — what the rewrite reads
export interface DocGapRewriteSource {
  question: string;
  reply: string;
}

// DEV_NOTE: A candidate is a turn that searched and whose reply cites nothing. A search that was unavailable says
// nothing about the docs, so a turn with one is no candidate. Every search empty = LowRetrieval; a search found
// something the reply didn't use = Idk. null = no candidate.
export function docGapCandidateSignal(params: {
  searchStatuses: SearchHelpDocsStatusEnum[];
  hasReply: boolean;
  hasCitations: boolean;
}): DocGapSignalIntEnum | null {
  const { searchStatuses } = params;
  if (!params.hasReply || params.hasCitations || searchStatuses.length === 0) return null;
  if (searchStatuses.includes(SearchHelpDocsStatusEnum.Unavailable)) return null;
  return searchStatuses.every((status) => status === SearchHelpDocsStatusEnum.NoResults)
    ? DocGapSignalIntEnum.LowRetrieval
    : DocGapSignalIntEnum.Idk;
}

// DEV_NOTE: The backstop behind the rewrite's instructions: an email, or a run of six or more digits (a phone, account
// or record number), means the rewrite kept something it shouldn't, and the question is never stored. Names can't be
// matched by a pattern; they rest on the rewrite.
const DOC_GAP_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const DOC_GAP_LONG_NUMBER = /\d(?:[\s().-]*\d){5,}/;

export function docGapQuestionHasPersonalDetails(question: string): boolean {
  return DOC_GAP_EMAIL.test(question) || DOC_GAP_LONG_NUMBER.test(question);
}

// DEV_NOTE: The rewrite's answer held to what may be stored. null = no gap (answered, or the question is unusable).
export function parseDocGapRewrite(output: DocGapRewriteOutput): string | null {
  if (!output.wasUnanswered) return null;
  const question = output.questionGeneric.trim();
  if (question.length === 0 || question.length > DOC_GAP_QUESTION_MAX_CHARS) return null;
  return docGapQuestionHasPersonalDetails(question) ? null : question;
}

// DEV_NOTE: A group's centroid after one more question: the running mean over its questions
export function nextDocGapCentroid(
  centroid: number[],
  questionCount: number,
  embedding: number[],
): number[] {
  return centroid.map(
    (value, index) => (value * questionCount + (embedding[index] ?? 0)) / (questionCount + 1),
  );
}

// DEV_NOTE: Whether a group opens its Quality item now: only an Open group, only once over both floors
export function docGapClusterOpensQualityIssue(params: {
  isOpen: boolean;
  questionCount: number;
  conversationCount: number;
}): boolean {
  return (
    params.isOpen &&
    params.questionCount >= DOC_GAP_QUALITY_MIN_QUESTIONS &&
    params.conversationCount >= DOC_GAP_QUALITY_MIN_CONVERSATIONS
  );
}

export function docGapQualityNote(label: string): string {
  return `People keep asking something the help docs don't answer: "${label}". Add a document for it on the Knowledge page.`;
}

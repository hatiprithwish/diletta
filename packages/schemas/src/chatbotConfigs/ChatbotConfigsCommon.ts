import { z } from "zod";
import { EvalRunStatusIntEnum } from "../evalRuns/EvalRunsCommon";

export enum ChatbotConfigStatusIntEnum {
  Draft = 1,
  Testing = 2,
  Ready = 3,
  Published = 4,
  Archived = 5,
}

export enum ChatbotConfigStatusLabelEnum {
  Draft = "Draft",
  Testing = "Testing",
  Ready = "Ready",
  Published = "Published",
  Archived = "Archived",
}

export const CHATBOT_CONFIG_STATUS_LABEL_MAP: Record<
  ChatbotConfigStatusIntEnum,
  ChatbotConfigStatusLabelEnum
> = {
  [ChatbotConfigStatusIntEnum.Draft]: ChatbotConfigStatusLabelEnum.Draft,
  [ChatbotConfigStatusIntEnum.Testing]: ChatbotConfigStatusLabelEnum.Testing,
  [ChatbotConfigStatusIntEnum.Ready]: ChatbotConfigStatusLabelEnum.Ready,
  [ChatbotConfigStatusIntEnum.Published]: ChatbotConfigStatusLabelEnum.Published,
  [ChatbotConfigStatusIntEnum.Archived]: ChatbotConfigStatusLabelEnum.Archived,
};

// Whole Chatbot Config Body — DB shape (enums stored as integers)
// DEV_NOTE: body is the stored config spec at schemaVersion (read only through loadConfigSpec); jsonb, which drizzle
// reads untyped. id, companyId, chatbotId, approvedByRunId and the <verb>_by ids are internal — NEVER sent to a client.
export const ZChatbotConfig = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  chatbotId: z.string(),
  configVersion: z.number().int().min(1),
  schemaVersion: z.number().int().min(1),
  status: z.enum(ChatbotConfigStatusIntEnum),
  body: z.unknown(),
  bodyHash: z.string(),
  approvedByRunId: z.string().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  publishedBy: z.string().nullable(),
  publishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ChatbotConfig = z.infer<typeof ZChatbotConfig>;

// ─── Settings › Bots (M4-10): versions, drafts and publish

// DEV_NOTE: The statuses that count as "the chatbot's draft": one at a time per chatbot (a new one, or a copy of an
// older version, is refused while one exists). Only a Draft is edited, discarded or sent to testing. The gate (M5-4):
// Draft → Testing (an admin sends it), Testing → Ready (its gate run passed: approved_by_run_id) or → Draft (it
// didn't), Testing / Ready → Draft (an admin takes it back), Ready → Published.
export const CHATBOT_CONFIG_OPEN_STATUSES = [
  ChatbotConfigStatusIntEnum.Draft,
  ChatbotConfigStatusIntEnum.Testing,
  ChatbotConfigStatusIntEnum.Ready,
] as const;

export enum ChatbotConfigSortColumn {
  ConfigVersion = "configVersion",
}

export const CHATBOT_CONFIG_VERSIONS_PAGE_SIZE = 10;

// DEV_NOTE: The editor's pickers (Active tool versions, knowledge sources) are capped lists, not pages: a config
// pins at most 200 tools and lists at most 200 sources
export const CHATBOT_CONFIG_OPTIONS_MAX = 500;

// DEV_NOTE: The Bots table's Conversations column counts the conversations started over this many days
export const CHATBOT_CONVERSATION_COUNT_DAYS = 30;

// DEV_NOTE: A version's tests, from its newest eval run: Done → Passed / Failed by has_passed, a run that stopped
// (Failed) → Failed, Queued / Running → Running, no run → NotRun
export enum ChatbotConfigTestResultEnum {
  Passed = "Passed",
  Failed = "Failed",
  Running = "Running",
  NotRun = "NotRun",
}

export const CHATBOT_CONFIG_TEST_RESULT_LABEL_MAP: Record<ChatbotConfigTestResultEnum, string> = {
  [ChatbotConfigTestResultEnum.Passed]: "Passed",
  [ChatbotConfigTestResultEnum.Failed]: "Failed",
  [ChatbotConfigTestResultEnum.Running]: "Running",
  [ChatbotConfigTestResultEnum.NotRun]: "Not tested",
};

export function chatbotConfigTestResult(
  run: { status: EvalRunStatusIntEnum; hasPassed: boolean | null } | null,
): ChatbotConfigTestResultEnum {
  if (!run) return ChatbotConfigTestResultEnum.NotRun;
  if (run.status === EvalRunStatusIntEnum.Failed) return ChatbotConfigTestResultEnum.Failed;
  if (run.status !== EvalRunStatusIntEnum.Done) return ChatbotConfigTestResultEnum.Running;
  return run.hasPassed ? ChatbotConfigTestResultEnum.Passed : ChatbotConfigTestResultEnum.Failed;
}

// DEV_NOTE: The versions an admin can take back to Draft: one in the gate (M5-4)
export const CHATBOT_CONFIG_GATE_STATUSES = [
  ChatbotConfigStatusIntEnum.Testing,
  ChatbotConfigStatusIntEnum.Ready,
] as const;

// DEV_NOTE: Why a draft write, a send to testing or a publish was refused. 409 = the version's or the company's state
// refused it (no model key for a provider the routing uses, a pinned tool version not Active, a model the router can't
// price; M5-4: publish only from Ready, on a passed gate run that ran every active safety case); 400 = the body isn't
// a valid config spec.
export enum ChatbotConfigFailureEnum {
  NotDraft = "NotDraft",
  DraftExists = "DraftExists",
  InvalidBody = "InvalidBody",
  ModelKeyMissing = "ModelKeyMissing",
  ModelNotPriced = "ModelNotPriced",
  ToolNotActive = "ToolNotActive",
  NotInGate = "NotInGate",
  NotReady = "NotReady",
  NotApproved = "NotApproved",
  GateOutdated = "GateOutdated",
}

export const CHATBOT_CONFIG_FAILURE_HTTP_STATUS_MAP: Record<ChatbotConfigFailureEnum, 400 | 409> = {
  [ChatbotConfigFailureEnum.NotDraft]: 409,
  [ChatbotConfigFailureEnum.DraftExists]: 409,
  [ChatbotConfigFailureEnum.InvalidBody]: 400,
  [ChatbotConfigFailureEnum.ModelKeyMissing]: 409,
  [ChatbotConfigFailureEnum.ModelNotPriced]: 409,
  [ChatbotConfigFailureEnum.ToolNotActive]: 409,
  [ChatbotConfigFailureEnum.NotInGate]: 409,
  [ChatbotConfigFailureEnum.NotReady]: 409,
  [ChatbotConfigFailureEnum.NotApproved]: 409,
  [ChatbotConfigFailureEnum.GateOutdated]: 409,
};

// DEV_NOTE: The audit log's On column for a version: "<chatbot name> v<n>"
export const chatbotConfigLabel = (chatbotName: string, configVersion: number): string =>
  `${chatbotName} v${configVersion}`;

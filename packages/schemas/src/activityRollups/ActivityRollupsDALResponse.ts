import type { ApiResponse } from "../common";
import type { ConversationOutcomeIntEnum } from "../conversations";
import type { FeedbackRatingIntEnum } from "../feedback";
import type { ModelCallProvider } from "../modelCalls";
import type { ActivityRollupChangeRequestAction } from "./ActivityRollupsCommon";

// DEV_NOTE: Grouped counts and sums from the source tables, one entry per group. A model call's chatbotId is null for
// a background job (no chatbot); isEval says it was made for an eval run, whether or not it carries the chatbot under
// test. Sums arrive as decimal strings so a cost stays exact.
export type ConversationRollupGroup = {
  chatbotId: string;
  outcome: ConversationOutcomeIntEnum | null;
  count: number;
};

export type FeedbackRollupGroup = {
  chatbotId: string;
  rating: FeedbackRatingIntEnum;
  count: number;
};

export type ChangeRequestRollupGroup = {
  chatbotId: string;
  action: ActivityRollupChangeRequestAction;
  toolName: string;
  count: number;
};

export type ModelCallRollupGroup = {
  chatbotId: string | null;
  isEval: boolean;
  taskType: string;
  provider: ModelCallProvider;
  model: string;
  count: number;
  inputTokens: string;
  outputTokens: string;
  costUsd: string;
};

export interface ConversationRollupGroupsDALResponse extends ApiResponse {
  groups?: ConversationRollupGroup[];
}

export interface FeedbackRollupGroupsDALResponse extends ApiResponse {
  groups?: FeedbackRollupGroup[];
}

export interface ChangeRequestRollupGroupsDALResponse extends ApiResponse {
  groups?: ChangeRequestRollupGroup[];
}

export interface ModelCallRollupGroupsDALResponse extends ApiResponse {
  groups?: ModelCallRollupGroup[];
}

export interface ActivityRollupsWriteDALResponse extends ApiResponse {
  rowCount?: number;
}

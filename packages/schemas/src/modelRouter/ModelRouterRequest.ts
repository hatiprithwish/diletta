import type { ConfigSpec, ModelTierEnum } from "../configSpec";
import type { ModelTaskTypeEnum } from "../modelCalls";

// DEV_NOTE: Server-side only: never crosses an API, hence no "Api" in the file name. Called by the Conversation DO and
// the eval runner (ModelRouterRepo.getModel). Every id is internal and resolved server-side (WidgetIdentity, the
// conversation row). chatbotId / chatbotUserId / conversationId are null for a background job, evalRunId for anything
// but an eval. tier null = the routing's defaultTier. routing comes from the chatbot's loaded config spec
// (loadConfigSpec), so the router never reads chatbot_configs itself.
export interface GetModelRequest {
  companyId: string;
  chatbotId: string | null;
  chatbotUserId: string | null;
  conversationId: string | null;
  evalRunId: string | null;
  turnId: string | null;
  taskType: ModelTaskTypeEnum;
  tier: ModelTierEnum | null;
  routing: ConfigSpec["routing"];
}

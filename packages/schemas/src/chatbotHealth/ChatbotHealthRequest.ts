import type { ActivityRollupDay } from "../activityRollups/ActivityRollupsCommon";
import type { ChatbotHealthDrop } from "./ChatbotHealthCommon";

// DEV_NOTE: Server-side only — one chatbot's drop on one day, for ChatbotHealthProvider.record (internal ids)
export interface RecordChatbotHealthDropRequest {
  companyId: string;
  chatbotId: string;
  day: ActivityRollupDay;
  drops: ChatbotHealthDrop[];
}

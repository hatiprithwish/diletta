import type { ActivityRollupDay } from "../activityRollups/ActivityRollupsCommon";

// DEV_NOTE: Every chatbot's rollup rows of one company over [fromDay, toDay], both included (chatbot_id not null): the
// health check's read (M5-5)
export type GetChatbotHealthRollupsDALRequest = {
  companyId: string;
  fromDay: ActivityRollupDay;
  toDay: ActivityRollupDay;
};

// DEV_NOTE: Whether a quality issue already has an event naming this day (ZChatbotHealthDropDetail.day)
export type HasChatbotHealthDayDALRequest = {
  companyId: string;
  qualityIssueId: string;
  day: ActivityRollupDay;
};

import type { ApiResponse } from "../common";

// DEV_NOTE: What recording a drop did: opened the chatbot's Health drop issue, added the day to the open one, or
// nothing (the open issue already covers the day). outboxId = the event to relay, when one was written.
export interface RecordChatbotHealthDropResponse extends ApiResponse {
  isOpened?: boolean;
  isAdded?: boolean;
  outboxId?: string;
}

// DEV_NOTE: The daily check (M5-5): the day it judged, how many chatbots it judged, how many dropped, and the companies
// whose check failed (logged; the next day's check judges its own day only)
export interface CheckChatbotHealthResponse extends ApiResponse {
  day?: string;
  checkedCount?: number;
  dropCount?: number;
  failedCompanyCount?: number;
}

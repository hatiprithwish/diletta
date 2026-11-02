import type { ApiResponse } from "../common";

// DEV_NOTE: What recording a detection did: opened the conversation's Prompt injection issue (the conversation's first
// detection), or nothing (an earlier one already did). outboxIds = the events to relay, when some were written.
export interface RecordPromptInjectionResponse extends ApiResponse {
  isOpened?: boolean;
  outboxIds?: string[];
}

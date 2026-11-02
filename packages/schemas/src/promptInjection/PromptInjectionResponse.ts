import type { ApiResponse } from "../common";

// DEV_NOTE: What recording a detection did: opened its Prompt injection issue (the first for its help doc, or for its
// conversation and location), or nothing (an earlier one already did). outboxIds = the events to relay, when some were
// written.
export interface RecordPromptInjectionResponse extends ApiResponse {
  isOpened?: boolean;
  outboxIds?: string[];
}

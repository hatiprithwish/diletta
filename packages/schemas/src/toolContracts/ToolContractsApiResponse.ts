import type { ApiResponse } from "../common";
import type { ToolContractSyncFailureIntEnum, ToolSchemaChangeEnum } from "./ToolContractsCommon";

// DEV_NOTE: One tool whose schema the spec changed (ADR 0009). toVersion is null in a dry run, which writes nothing.
export interface ToolContractChange {
  name: string;
  fromVersion: number;
  toVersion: number | null;
  change: ToolSchemaChangeEnum;
  // Field paths and what changed, never a value
  notes: string[];
}

// What a sync of one connection found. isUnchanged: the spec's hash is the one already read (nothing was derived).
// failure: why part or all of it didn't happen (a tool whose operation is gone, a spec that can't be read); tools that
// could be derived are still synced.
export interface SyncToolContractApiResponse extends ApiResponse {
  isNotFound?: boolean;
  isUnchanged?: boolean;
  isDryRun?: boolean;
  failure?: ToolContractSyncFailureIntEnum;
  changes?: ToolContractChange[];
  // Tools left alone: a Draft version exists (an operator is editing it), or the tool was bound to another connection
  skipped?: string[];
  // Each tool the sync couldn't derive, with why
  problems?: string[];
}

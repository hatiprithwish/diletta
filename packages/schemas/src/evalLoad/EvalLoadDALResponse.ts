import type { BudgetRefusalEnum } from "../budget/BudgetCommon";
import type { ApiResponse } from "../common";
import type {
  BudgetSnapshot,
  BudgetTimings,
  LoadModelCallStats,
  LoadOutboxStats,
} from "./EvalLoadCommon";

// DEV_NOTE: The database's clock: a window's start is taken from it, because created_at is too (a Worker's clock may differ)
export interface LoadWindowStartDALResponse extends ApiResponse {
  startedAt?: Date;
}

export interface LoadModelCallStatsDALResponse extends ApiResponse {
  stats?: LoadModelCallStats;
}

export interface LoadOutboxStatsDALResponse extends ApiResponse {
  stats?: LoadOutboxStats;
}

// DEV_NOTE: Server-side only (BudgetDO RPC): the ledger as it stands, and the timings with when they began counting
export interface BudgetSnapshotResponse extends ApiResponse {
  snapshot?: BudgetSnapshot;
}

export interface BudgetTimingsResponse extends ApiResponse {
  timings?: BudgetTimings;
  timingsSince?: number;
}

// DEV_NOTE: Server-side only (EvalLoadRepo): the window's start and the summary, before they become JSON
export interface EvalLoadWindowResponse extends ApiResponse {
  startedAt?: string;
  budget?: BudgetSnapshot;
}

export interface EvalLoadSummaryResponse extends ApiResponse {
  budget?: BudgetSnapshot;
  timings?: BudgetTimings;
  timingsSince?: number;
  modelCalls?: LoadModelCallStats;
  outbox?: LoadOutboxStats;
}

export interface EvalLoadReserveResponse extends ApiResponse {
  isAdmitted?: boolean;
  reservationId?: string;
  refusal?: BudgetRefusalEnum;
  serverMs?: number;
}

export interface EvalLoadReleaseResponse extends ApiResponse {
  serverMs?: number;
}

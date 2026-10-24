import type { ModelCall } from "./ModelCallsCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal ids). Server-side only.
export interface ModelCallDALResponse extends ApiResponse {
  modelCall?: ModelCall;
}

export interface ModelCallsDALResponse extends ApiResponse {
  modelCalls?: ModelCall[];
}

// DEV_NOTE: totalCostUsd is the numeric sum as pg returns it ("0.000000" when no rows)
export interface ModelCallCostSumDALResponse extends ApiResponse {
  totalCostUsd?: string;
}

// DEV_NOTE: One turn's spend (turnId null = calls with no turn). costUsd is the numeric sum as text ("0.000000" at
// least), so it stays exact. pendingCount / unknownCount: rows whose cost may still change or isn't real.
export interface ConversationTurnCostRow {
  turnId: string | null;
  costUsd: string;
  pendingCount: number;
  unknownCount: number;
  firstAt: Date;
}

export interface ConversationTurnCostsDALResponse extends ApiResponse {
  turnCosts?: ConversationTurnCostRow[];
}

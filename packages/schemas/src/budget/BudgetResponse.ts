import type { ApiResponse } from "../common";
import type { BudgetRefusalEnum } from "./BudgetCommon";

// DEV_NOTE: Server-side only (BudgetDO RPC). isSuccess false always carries the refusal.
export interface BudgetAdmissionResponse extends ApiResponse {
  refusal?: BudgetRefusalEnum;
}

export interface BudgetReservationResponse extends ApiResponse {
  reservationId?: string;
  refusal?: BudgetRefusalEnum;
}

// DEV_NOTE: Server-side only (BudgetRepo). spendingBudgetUsd has the platform default applied (never null);
// spentUsd is set only when the request asked for it.
export interface BudgetSeedResponse extends ApiResponse {
  spendingBudgetUsd?: string;
  spentUsd?: string;
}

// DEV_NOTE: Server-side only — one provider call's hold, from the router to the recording middleware and back with
// the call's record. reservationId is BudgetDO's; amountMicros / tokens are what was held. A refused call carries the
// refusal and never reaches the provider.
export type ModelCallReservation =
  | {
      isSuccess: true;
      reservationId: string;
      amountMicros: number;
      tokens: number;
      refusal?: undefined;
    }
  | { isSuccess: false; refusal: BudgetRefusalEnum };

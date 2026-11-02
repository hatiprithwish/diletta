import { z } from "zod";
import { LOAD_CONTENTION_MAX_AMOUNT_MICROS } from "./EvalLoadCommon";

// DEV_NOTE: Bodies and queries the load harness sends to /eval/load/* (M6-5). Same eval JWT as /eval/*; the company
// and the staging connection come from the token, never from a body.

// GET /eval/load/summary?since=: when the window began (the answer of POST /eval/load/window)
export const ZEvalLoadSummaryApiRequest = z
  .object({ since: z.iso.datetime() })
  .meta({ id: "EvalLoadSummaryApiRequest" });
export type EvalLoadSummaryApiRequest = z.infer<typeof ZEvalLoadSummaryApiRequest>;

// DEV_NOTE: One contention hold: amountMicros held against the company's budget as a model call would, for no user
export const ZEvalLoadReserveApiRequest = z
  .object({ amountMicros: z.number().int().min(1).max(LOAD_CONTENTION_MAX_AMOUNT_MICROS) })
  .meta({ id: "EvalLoadReserveApiRequest" });
export type EvalLoadReserveApiRequest = z.infer<typeof ZEvalLoadReserveApiRequest>;

// DEV_NOTE: Gives a contention hold back at no cost
export const ZEvalLoadReleaseApiRequest = z
  .object({ reservationId: z.uuid() })
  .meta({ id: "EvalLoadReleaseApiRequest" });
export type EvalLoadReleaseApiRequest = z.infer<typeof ZEvalLoadReleaseApiRequest>;

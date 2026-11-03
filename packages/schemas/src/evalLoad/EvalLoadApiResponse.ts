import { z } from "zod";
import { ZEvalRefusalApiResponse } from "../evalHarness/EvalHarnessApiResponse";
import {
  ZBudgetSnapshot,
  ZBudgetTimings,
  ZEvalLoadConstants,
  ZLoadBudgetRefusal,
  ZLoadModelCallStats,
  ZLoadOutboxStats,
} from "./EvalLoadCommon";
import {
  ZEvalLoadReleaseApiRequest,
  ZEvalLoadReserveApiRequest,
  ZEvalLoadSummaryApiRequest,
} from "./EvalLoadApiRequest";

// POST /eval/load/window: a new window began. startedAt is the server's clock; the DO's timings start over; the
// snapshot is the ledger at that moment (the baseline the summary's spend is compared with).
export const ZEvalLoadWindowApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    startedAt: z.iso.datetime(),
    budget: ZBudgetSnapshot,
  })
  .meta({ id: "EvalLoadWindowApiResponse" });
export type EvalLoadWindowApiResponse = z.infer<typeof ZEvalLoadWindowApiResponse>;

// GET /eval/load/summary: the window so far
export const ZEvalLoadSummaryApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    budget: ZBudgetSnapshot,
    timings: ZBudgetTimings,
    // DEV_NOTE: Epoch milliseconds the timings began counting; later than the window's start = the DO was evicted
    timingsSince: z.number().int().min(0),
    modelCalls: ZLoadModelCallStats,
    outbox: ZLoadOutboxStats,
  })
  .meta({ id: "EvalLoadSummaryApiResponse" });
export type EvalLoadSummaryApiResponse = z.infer<typeof ZEvalLoadSummaryApiResponse>;

// POST /eval/load/reserve: isAdmitted false = the budget refused (refusal says why); serverMs = how long the Worker
// waited for BudgetDO, queueing behind other calls included
export const ZEvalLoadReserveApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    isAdmitted: z.boolean(),
    reservationId: z.uuid().optional(),
    refusal: ZLoadBudgetRefusal.optional(),
    serverMs: z.number().min(0),
  })
  .meta({ id: "EvalLoadReserveApiResponse" });
export type EvalLoadReserveApiResponse = z.infer<typeof ZEvalLoadReserveApiResponse>;

export const ZEvalLoadReleaseApiResponse = z
  .object({
    isSuccess: z.literal(true),
    message: z.string(),
    serverMs: z.number().min(0),
  })
  .meta({ id: "EvalLoadReleaseApiResponse" });
export type EvalLoadReleaseApiResponse = z.infer<typeof ZEvalLoadReleaseApiResponse>;

// DEV_NOTE: The whole /eval/load/* API as one object, for the JSON Schema export (evals/schemas/eval-load.schema.json):
// each message is a $def named by its meta id, so the generated Python module has one model per message. Never sent.
export const ZEvalLoadApiContract = z.object({
  windowResponse: ZEvalLoadWindowApiResponse,
  summaryRequest: ZEvalLoadSummaryApiRequest,
  summaryResponse: ZEvalLoadSummaryApiResponse,
  reserveRequest: ZEvalLoadReserveApiRequest,
  reserveResponse: ZEvalLoadReserveApiResponse,
  releaseRequest: ZEvalLoadReleaseApiRequest,
  releaseResponse: ZEvalLoadReleaseApiResponse,
  refusal: ZEvalRefusalApiResponse,
  constants: ZEvalLoadConstants,
});

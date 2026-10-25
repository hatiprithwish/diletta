import { z } from "zod";
import { ZPageApiRequest } from "../common";
import { ZEvalRunCaseSortColumn, ZEvalRunSortColumn } from "./EvalRunsCommon";

// DEV_NOTE: GET /dashboard/eval-runs (M4-8). Runs grow without bound, so the list is paged, newest first. botId = a
// chatbot's public id (DESIGN.md §6): only runs of that chatbot's configs; absent = the whole company, unknown → 404.
export const ZGetEvalRunsApiRequest = ZPageApiRequest.extend({
  botId: z.string().min(1).optional(),
  sortColumn: ZEvalRunSortColumn.nullable().optional(),
});
export type GetEvalRunsApiRequest = z.infer<typeof ZGetEvalRunsApiRequest>;

// DEV_NOTE: GET /dashboard/eval-runs/summary: the metric strip, for botId's chatbot, else the company's default one
export const ZGetEvalRunsSummaryApiRequest = z.object({
  botId: z.string().min(1).optional(),
});
export type GetEvalRunsSummaryApiRequest = z.infer<typeof ZGetEvalRunsSummaryApiRequest>;

// DEV_NOTE: GET /dashboard/eval-runs/:publicId/cases: one run's cases with how many attempts passed, paged (a chatbot
// can have any number of cases); failed first by default
export const ZGetEvalRunCasesApiRequest = ZPageApiRequest.extend({
  sortColumn: ZEvalRunCaseSortColumn.nullable().optional(),
});
export type GetEvalRunCasesApiRequest = z.infer<typeof ZGetEvalRunCasesApiRequest>;

// DEV_NOTE: The Tests page's tabs (apps/web, M4-8)
export enum TestsPageTabEnum {
  Runs = "runs",
  Cases = "cases",
}

export const ZTestsPageTab = z.enum(TestsPageTabEnum);

// DEV_NOTE: /tests URL search: the tab (absent = Runs) and its page; an unknown value falls back to the default instead
// of failing the page
export const ZTestsPageSearch = z.object({
  tab: ZTestsPageTab.optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type TestsPageSearch = z.infer<typeof ZTestsPageSearch>;

// DEV_NOTE: /tests/$id URL search: the page of the run's cases and the case whose detail card is open
export const ZTestRunPageSearch = z.object({
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  caseId: z.string().min(1).optional().catch(undefined),
});
export type TestRunPageSearch = z.infer<typeof ZTestRunPageSearch>;

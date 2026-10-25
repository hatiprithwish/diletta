import { z } from "zod";
import { ZPageApiRequest } from "../common";
import {
  ZEvalCaseDraft,
  ZEvalCaseMessages,
  ZEvalCaseName,
  ZEvalCaseRubric,
  ZEvalCaseSortColumn,
} from "./EvalCasesCommon";

// DEV_NOTE: GET /dashboard/eval-cases (M4-8): the company's cases and the platform's (which run against every chatbot),
// paged, newest first. botId = a chatbot's public id: its cases and the platform's; absent = every chatbot's, unknown
// → 404.
export const ZGetEvalCasesApiRequest = ZPageApiRequest.extend({
  botId: z.string().min(1).optional(),
  sortColumn: ZEvalCaseSortColumn.nullable().optional(),
});
export type GetEvalCasesApiRequest = z.infer<typeof ZGetEvalCasesApiRequest>;

// DEV_NOTE: POST /dashboard/eval-cases: a v1 case for botId's chatbot, else the company's default one. Saved active
// and never a safety case (those are the platform's).
export const ZCreateEvalCaseApiRequest = ZEvalCaseDraft.extend({
  botId: z.string().min(1).optional(),
});
export type CreateEvalCaseApiRequest = z.infer<typeof ZCreateEvalCaseApiRequest>;

// DEV_NOTE: PATCH /dashboard/eval-cases/:publicId: the company's own case only (a platform case answers 404). An absent
// field keeps its value; messages and rubric replace the stored v1 body's part. At least one field.
export const ZUpdateEvalCaseApiRequest = z
  .object({
    name: ZEvalCaseName.optional(),
    messages: ZEvalCaseMessages.optional(),
    rubric: ZEvalCaseRubric.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.messages !== undefined ||
      body.rubric !== undefined ||
      body.isActive !== undefined,
    { message: "Nothing to change" },
  );
export type UpdateEvalCaseApiRequest = z.infer<typeof ZUpdateEvalCaseApiRequest>;

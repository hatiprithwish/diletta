import { z } from "zod";
import { ZPageApiRequest } from "../common";
import {
  QUALITY_ISSUE_NOTE_MAX_CHARS,
  QualityIssueTypeIntEnum,
  ZQualityIssueListTab,
  ZQualityIssueSortColumn,
  ZQualityTestDraft,
} from "./QualityIssuesCommon";

// DEV_NOTE: GET /dashboard/quality-issues (M4-6). A company has any number of issues, so the list is paged. botId = a
// chatbot's public id (DESIGN.md §6); absent = the whole company, unknown → 404. tab absent = Open.
export const ZGetQualityIssuesApiRequest = ZPageApiRequest.extend({
  tab: ZQualityIssueListTab.optional(),
  botId: z.string().min(1).optional(),
  sortColumn: ZQualityIssueSortColumn.nullable().optional(),
});
export type GetQualityIssuesApiRequest = z.infer<typeof ZGetQualityIssuesApiRequest>;

// DEV_NOTE: PATCH /dashboard/quality-issues/:publicId: triage an Open issue. An absent field keeps its value, null
// clears it; a blank note clears it too. At least one field.
export const ZTriageQualityIssueApiRequest = z
  .object({
    issueType: z.enum(QualityIssueTypeIntEnum).nullable().optional(),
    note: z
      .string()
      .trim()
      .max(QUALITY_ISSUE_NOTE_MAX_CHARS)
      .transform((note) => (note === "" ? null : note))
      .nullable()
      .optional(),
  })
  .refine((body) => body.issueType !== undefined || body.note !== undefined, {
    message: "Nothing to change",
  });
export type TriageQualityIssueApiRequest = z.infer<typeof ZTriageQualityIssueApiRequest>;

// DEV_NOTE: POST /dashboard/quality-issues/:publicId/convert: the test as the admin reviewed it (the draft from
// /test-draft, edited). Saved as it is: the admin confirms there is nothing personal left in it.
export const ZConvertQualityIssueApiRequest = ZQualityTestDraft;
export type ConvertQualityIssueApiRequest = z.infer<typeof ZConvertQualityIssueApiRequest>;

// DEV_NOTE: The Quality pages' URL search (apps/web validateSearch): the tab and the page; an unknown value falls back
// to the default instead of failing the page
export const ZQualityPageSearch = z.object({
  tab: ZQualityIssueListTab.optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type QualityPageSearch = z.infer<typeof ZQualityPageSearch>;

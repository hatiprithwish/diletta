import { z } from "zod";
import { ZPageApiRequest } from "../common";
import { ZDocGapClusterListTab, ZDocGapClusterSortColumn } from "./DocGapClustersCommon";

// DEV_NOTE: GET /dashboard/doc-gap-clusters (M4-7). Questions keep coming, so the groups are paged. tab absent = Open.
export const ZGetDocGapClustersApiRequest = ZPageApiRequest.extend({
  tab: ZDocGapClusterListTab.optional(),
  sortColumn: ZDocGapClusterSortColumn.nullable().optional(),
});
export type GetDocGapClustersApiRequest = z.infer<typeof ZGetDocGapClustersApiRequest>;

// DEV_NOTE: POST /dashboard/doc-gap-clusters/:publicId/answer: the document (any source of the company) that answers
// the group. "Add a document" uploads it first, or the admin picks one that exists.
export const ZAnswerDocGapClusterApiRequest = z.object({
  documentPublicId: z.string().min(1),
});
export type AnswerDocGapClusterApiRequest = z.infer<typeof ZAnswerDocGapClusterApiRequest>;

// DEV_NOTE: The Knowledge page's URL search (apps/web validateSearch): the groups' tab and page, and the Sources
// table's page; an unknown value falls back to the default instead of failing the page
export const ZKnowledgePageSearch = z.object({
  tab: ZDocGapClusterListTab.optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  sourcesPage: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type KnowledgePageSearch = z.infer<typeof ZKnowledgePageSearch>;

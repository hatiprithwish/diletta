import { z } from "zod";
import {
  KnowledgeSourceStatusIntEnum,
  KnowledgeSourceSyncFrequencyIntEnum,
  ZKnowledgeSourceBase,
  ZKnowledgeSourceName,
  ZKnowledgeSourceSortColumn,
} from "./KnowledgeSourcesCommon";
import { ZPageApiRequest } from "../common";
import { ZKnowledgeDocumentSearch } from "../knowledgeDocuments/KnowledgeDocumentsApiRequest";

export const ZCreateKnowledgeSourceApiRequest = z.object({
  knowledgeSource: ZKnowledgeSourceBase,
});
export type CreateKnowledgeSourceApiRequest = z.infer<typeof ZCreateKnowledgeSourceApiRequest>;

// DEV_NOTE: An admin pauses a source (any state; a running sync stops at its next page) or resumes a paused one
// (Active). Syncing and Failed are set by the sync only. The type and url never change: a new url is a new source. The
// name can change on any source (M4-7).
export const ZUpdateKnowledgeSourceApiRequest = z.object({
  knowledgeSource: z
    .object({
      name: ZKnowledgeSourceName,
      syncFrequency: z.enum(KnowledgeSourceSyncFrequencyIntEnum),
      status: z.union([
        z.literal(KnowledgeSourceStatusIntEnum.Active),
        z.literal(KnowledgeSourceStatusIntEnum.Paused),
      ]),
    })
    .partial()
    .refine(
      (body) =>
        body.name !== undefined || body.syncFrequency !== undefined || body.status !== undefined,
      {
        message: "Nothing to update",
      },
    ),
});
export type UpdateKnowledgeSourceApiRequest = z.infer<typeof ZUpdateKnowledgeSourceApiRequest>;

// DEV_NOTE: A company can have any number of sources, so the list is paged. status narrows it to one state (the
// Knowledge page's failed-sync banners read every Failed source, whatever page of the table is shown).
export const ZGetKnowledgeSourcesApiRequest = ZPageApiRequest.extend({
  sortColumn: ZKnowledgeSourceSortColumn.nullable().optional(),
  status: z.coerce.number().pipe(z.enum(KnowledgeSourceStatusIntEnum)).optional(),
});
export type GetKnowledgeSourcesApiRequest = z.infer<typeof ZGetKnowledgeSourcesApiRequest>;

// DEV_NOTE: The Knowledge page's rows per page for sources and for one source's documents (M4-7)
export const KNOWLEDGE_SOURCES_PAGE_SIZE = 25;
export const KNOWLEDGE_DOCUMENTS_PAGE_SIZE = 25;

// DEV_NOTE: A source's page (/knowledge/$id) URL search: its documents' page, a title filter, and documentId = the
// document to show highlighted (a gap cluster's "Answered by" link sets both). An unknown value falls back to the
// default.
export const ZKnowledgeSourcePageSearch = z.object({
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  search: ZKnowledgeDocumentSearch.catch(undefined),
  documentId: z.string().min(1).optional().catch(undefined),
});
export type KnowledgeSourcePageSearch = z.infer<typeof ZKnowledgeSourcePageSearch>;

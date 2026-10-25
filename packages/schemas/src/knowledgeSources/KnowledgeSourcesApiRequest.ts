import { z } from "zod";
import {
  KnowledgeSourceStatusIntEnum,
  KnowledgeSourceSyncFrequencyIntEnum,
  ZKnowledgeSourceBase,
  ZKnowledgeSourceName,
  ZKnowledgeSourceSortColumn,
} from "./KnowledgeSourcesCommon";
import { ZPageApiRequest } from "../common";

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

// DEV_NOTE: A company can have any number of sources, so the list is paged
export const ZGetKnowledgeSourcesApiRequest = ZPageApiRequest.extend({
  sortColumn: ZKnowledgeSourceSortColumn.nullable().optional(),
});
export type GetKnowledgeSourcesApiRequest = z.infer<typeof ZGetKnowledgeSourcesApiRequest>;

// DEV_NOTE: The Knowledge page's rows per page for sources and for one source's documents (M4-7)
export const KNOWLEDGE_SOURCES_PAGE_SIZE = 25;
export const KNOWLEDGE_DOCUMENTS_PAGE_SIZE = 25;

// DEV_NOTE: A source's page (/knowledge/$id) URL search: its documents' page; an unknown value falls back to the first
export const ZKnowledgeSourcePageSearch = z.object({
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type KnowledgeSourcePageSearch = z.infer<typeof ZKnowledgeSourcePageSearch>;

import { z } from "zod";
import {
  KnowledgeSourceStatusIntEnum,
  KnowledgeSourceSyncFrequencyIntEnum,
  ZKnowledgeSourceBase,
  ZKnowledgeSourceSortColumn,
} from "./KnowledgeSourcesCommon";
import { ZPageApiRequest } from "../common";

export const ZCreateKnowledgeSourceApiRequest = z.object({
  knowledgeSource: ZKnowledgeSourceBase,
});
export type CreateKnowledgeSourceApiRequest = z.infer<typeof ZCreateKnowledgeSourceApiRequest>;

// DEV_NOTE: An admin pauses a source (any state; a running sync stops at its next page) or resumes a paused one
// (Active). Syncing and Failed are set by the sync only. The type and url never change: a new url is a new source.
export const ZUpdateKnowledgeSourceApiRequest = z.object({
  knowledgeSource: z
    .object({
      syncFrequency: z.enum(KnowledgeSourceSyncFrequencyIntEnum),
      status: z.union([
        z.literal(KnowledgeSourceStatusIntEnum.Active),
        z.literal(KnowledgeSourceStatusIntEnum.Paused),
      ]),
    })
    .partial()
    .refine((body) => body.syncFrequency !== undefined || body.status !== undefined, {
      message: "Nothing to update",
    }),
});
export type UpdateKnowledgeSourceApiRequest = z.infer<typeof ZUpdateKnowledgeSourceApiRequest>;

// DEV_NOTE: A company can have any number of sources, so the list is paged
export const ZGetKnowledgeSourcesApiRequest = ZPageApiRequest.extend({
  sortColumn: ZKnowledgeSourceSortColumn.nullable().optional(),
});
export type GetKnowledgeSourcesApiRequest = z.infer<typeof ZGetKnowledgeSourcesApiRequest>;

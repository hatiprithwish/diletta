import { z } from "zod";

export enum ActivityLogActorTypeIntEnum {
  ChatbotUser = 1,
  Admin = 2,
  Operator = 3,
  System = 4,
}

export enum ActivityLogActorTypeLabelEnum {
  ChatbotUser = "Chatbot user",
  Admin = "Admin",
  Operator = "Operator",
  System = "System",
}

export const ACTIVITY_LOG_ACTOR_TYPE_LABEL_MAP: Record<
  ActivityLogActorTypeIntEnum,
  ActivityLogActorTypeLabelEnum
> = {
  [ActivityLogActorTypeIntEnum.ChatbotUser]: ActivityLogActorTypeLabelEnum.ChatbotUser,
  [ActivityLogActorTypeIntEnum.Admin]: ActivityLogActorTypeLabelEnum.Admin,
  [ActivityLogActorTypeIntEnum.Operator]: ActivityLogActorTypeLabelEnum.Operator,
  [ActivityLogActorTypeIntEnum.System]: ActivityLogActorTypeLabelEnum.System,
};

// Activity Log Body — the fields a writer supplies for one event
// DEV_NOTE: actorId and entityId are polymorphic internal ids (by actorType / entityType); parentLogId and rootLogId
// point into the same company's activity tree (rootLogId null = this row is a root). detail holds ids and reasons,
// never values: no plaintext, PII or host token.
export const ZActivityLogBase = z.object({
  actorType: z.enum(ActivityLogActorTypeIntEnum),
  actorId: z.string().nullable(),
  entityType: z.string().trim().min(1),
  entityId: z.string().nullable(),
  entityAction: z.string().trim().min(1),
  entityVersion: z.number().int().min(1).nullable(),
  parentLogId: z.string().nullable(),
  rootLogId: z.string().nullable(),
  detail: z.record(z.string(), z.json()),
});
export type ActivityLogBase = z.infer<typeof ZActivityLogBase>;

// Whole Activity Log Body — DB shape (enums stored as integers)
// DEV_NOTE: Append-only, so no publicId or updatedAt. Every id is internal; activity rows never reach a client as-is.
// detail is jsonb, which drizzle reads untyped.
export const ZActivityLog = ZActivityLogBase.extend({
  id: z.string(),
  companyId: z.string(),
  detail: z.unknown(),
  createdAt: z.date(),
});
export type ActivityLog = z.infer<typeof ZActivityLog>;

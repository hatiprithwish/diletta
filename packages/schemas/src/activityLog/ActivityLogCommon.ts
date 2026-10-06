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

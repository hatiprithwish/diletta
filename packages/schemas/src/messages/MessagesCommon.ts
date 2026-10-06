export enum MessageRoleIntEnum {
  User = 1,
  Assistant = 2,
  Tool = 3,
}

export enum MessageRoleLabelEnum {
  User = "User",
  Assistant = "Assistant",
  Tool = "Tool",
}

export const MESSAGE_ROLE_LABEL_MAP: Record<MessageRoleIntEnum, MessageRoleLabelEnum> = {
  [MessageRoleIntEnum.User]: MessageRoleLabelEnum.User,
  [MessageRoleIntEnum.Assistant]: MessageRoleLabelEnum.Assistant,
  [MessageRoleIntEnum.Tool]: MessageRoleLabelEnum.Tool,
};

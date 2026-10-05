export enum ConversationStatusIntEnum {
  Open = 1,
  Closed = 2,
}

export enum ConversationStatusLabelEnum {
  Open = "Open",
  Closed = "Closed",
}

export const CONVERSATION_STATUS_LABEL_MAP: Record<
  ConversationStatusIntEnum,
  ConversationStatusLabelEnum
> = {
  [ConversationStatusIntEnum.Open]: ConversationStatusLabelEnum.Open,
  [ConversationStatusIntEnum.Closed]: ConversationStatusLabelEnum.Closed,
};

export enum ConversationOutcomeIntEnum {
  Answered = 1,
  ActionDone = 2,
  Idk = 3,
  Handoff = 4,
  Abandoned = 5,
}

export enum ConversationOutcomeLabelEnum {
  Answered = "Answered",
  ActionDone = "Action done",
  Idk = "I don't know",
  Handoff = "Handoff",
  Abandoned = "Abandoned",
}

export const CONVERSATION_OUTCOME_LABEL_MAP: Record<
  ConversationOutcomeIntEnum,
  ConversationOutcomeLabelEnum
> = {
  [ConversationOutcomeIntEnum.Answered]: ConversationOutcomeLabelEnum.Answered,
  [ConversationOutcomeIntEnum.ActionDone]: ConversationOutcomeLabelEnum.ActionDone,
  [ConversationOutcomeIntEnum.Idk]: ConversationOutcomeLabelEnum.Idk,
  [ConversationOutcomeIntEnum.Handoff]: ConversationOutcomeLabelEnum.Handoff,
  [ConversationOutcomeIntEnum.Abandoned]: ConversationOutcomeLabelEnum.Abandoned,
};

export enum ChatbotConfigStatusIntEnum {
  Draft = 1,
  Testing = 2,
  Ready = 3,
  Published = 4,
  Archived = 5,
}

export enum ChatbotConfigStatusLabelEnum {
  Draft = "Draft",
  Testing = "Testing",
  Ready = "Ready",
  Published = "Published",
  Archived = "Archived",
}

export const CHATBOT_CONFIG_STATUS_LABEL_MAP: Record<
  ChatbotConfigStatusIntEnum,
  ChatbotConfigStatusLabelEnum
> = {
  [ChatbotConfigStatusIntEnum.Draft]: ChatbotConfigStatusLabelEnum.Draft,
  [ChatbotConfigStatusIntEnum.Testing]: ChatbotConfigStatusLabelEnum.Testing,
  [ChatbotConfigStatusIntEnum.Ready]: ChatbotConfigStatusLabelEnum.Ready,
  [ChatbotConfigStatusIntEnum.Published]: ChatbotConfigStatusLabelEnum.Published,
  [ChatbotConfigStatusIntEnum.Archived]: ChatbotConfigStatusLabelEnum.Archived,
};

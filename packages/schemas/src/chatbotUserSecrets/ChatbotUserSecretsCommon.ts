export enum ChatbotUserSecretStatusIntEnum {
  Active = 1,
  NeedsReauth = 2,
  Revoked = 3,
}

export enum ChatbotUserSecretStatusLabelEnum {
  Active = "Active",
  NeedsReauth = "Needs sign-in",
  Revoked = "Revoked",
}

export const CHATBOT_USER_SECRET_STATUS_LABEL_MAP: Record<
  ChatbotUserSecretStatusIntEnum,
  ChatbotUserSecretStatusLabelEnum
> = {
  [ChatbotUserSecretStatusIntEnum.Active]: ChatbotUserSecretStatusLabelEnum.Active,
  [ChatbotUserSecretStatusIntEnum.NeedsReauth]: ChatbotUserSecretStatusLabelEnum.NeedsReauth,
  [ChatbotUserSecretStatusIntEnum.Revoked]: ChatbotUserSecretStatusLabelEnum.Revoked,
};

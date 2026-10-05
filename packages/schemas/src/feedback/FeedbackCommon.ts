export enum FeedbackRatingIntEnum {
  Up = 1,
  Down = 2,
}

export enum FeedbackRatingLabelEnum {
  Up = "Up",
  Down = "Down",
}

export const FEEDBACK_RATING_LABEL_MAP: Record<FeedbackRatingIntEnum, FeedbackRatingLabelEnum> = {
  [FeedbackRatingIntEnum.Up]: FeedbackRatingLabelEnum.Up,
  [FeedbackRatingIntEnum.Down]: FeedbackRatingLabelEnum.Down,
};

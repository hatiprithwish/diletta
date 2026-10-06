export enum EventOutboxStatusIntEnum {
  Pending = 1,
  Published = 2,
  Failed = 3,
}

export enum EventOutboxStatusLabelEnum {
  Pending = "Pending",
  Published = "Published",
  Failed = "Failed",
}

export const EVENT_OUTBOX_STATUS_LABEL_MAP: Record<
  EventOutboxStatusIntEnum,
  EventOutboxStatusLabelEnum
> = {
  [EventOutboxStatusIntEnum.Pending]: EventOutboxStatusLabelEnum.Pending,
  [EventOutboxStatusIntEnum.Published]: EventOutboxStatusLabelEnum.Published,
  [EventOutboxStatusIntEnum.Failed]: EventOutboxStatusLabelEnum.Failed,
};

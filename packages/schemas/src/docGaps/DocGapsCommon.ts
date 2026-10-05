export enum DocGapSignalIntEnum {
  LowRetrieval = 1,
  Idk = 2,
  Handoff = 3,
  ThumbsDown = 4,
  Admin = 5,
}

export enum DocGapSignalLabelEnum {
  LowRetrieval = "Low retrieval",
  Idk = "I don't know",
  Handoff = "Handoff",
  ThumbsDown = "Thumbs down",
  Admin = "Admin",
}

export const DOC_GAP_SIGNAL_LABEL_MAP: Record<DocGapSignalIntEnum, DocGapSignalLabelEnum> = {
  [DocGapSignalIntEnum.LowRetrieval]: DocGapSignalLabelEnum.LowRetrieval,
  [DocGapSignalIntEnum.Idk]: DocGapSignalLabelEnum.Idk,
  [DocGapSignalIntEnum.Handoff]: DocGapSignalLabelEnum.Handoff,
  [DocGapSignalIntEnum.ThumbsDown]: DocGapSignalLabelEnum.ThumbsDown,
  [DocGapSignalIntEnum.Admin]: DocGapSignalLabelEnum.Admin,
};

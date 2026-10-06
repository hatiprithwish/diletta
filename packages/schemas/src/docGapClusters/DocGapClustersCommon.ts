export enum DocGapClusterStatusIntEnum {
  Open = 1,
  Answered = 2,
  Dismissed = 3,
}

export enum DocGapClusterStatusLabelEnum {
  Open = "Open",
  Answered = "Answered",
  Dismissed = "Dismissed",
}

export const DOC_GAP_CLUSTER_STATUS_LABEL_MAP: Record<
  DocGapClusterStatusIntEnum,
  DocGapClusterStatusLabelEnum
> = {
  [DocGapClusterStatusIntEnum.Open]: DocGapClusterStatusLabelEnum.Open,
  [DocGapClusterStatusIntEnum.Answered]: DocGapClusterStatusLabelEnum.Answered,
  [DocGapClusterStatusIntEnum.Dismissed]: DocGapClusterStatusLabelEnum.Dismissed,
};

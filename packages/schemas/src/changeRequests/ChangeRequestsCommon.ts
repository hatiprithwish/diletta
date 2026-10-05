export enum ChangeRequestStatusIntEnum {
  Proposed = 1,
  Approved = 2,
  Rejected = 3,
  Committing = 4,
  Committed = 5,
  Verified = 6,
  Mismatch = 7,
  Failed = 8,
  Undone = 9,
  Expired = 10,
  NeedsHuman = 11,
}

export enum ChangeRequestStatusLabelEnum {
  Proposed = "Proposed",
  Approved = "Approved",
  Rejected = "Rejected",
  Committing = "Committing",
  Committed = "Committed",
  Verified = "Verified",
  Mismatch = "Mismatch",
  Failed = "Failed",
  Undone = "Undone",
  Expired = "Expired",
  NeedsHuman = "Needs review",
}

export const CHANGE_REQUEST_STATUS_LABEL_MAP: Record<
  ChangeRequestStatusIntEnum,
  ChangeRequestStatusLabelEnum
> = {
  [ChangeRequestStatusIntEnum.Proposed]: ChangeRequestStatusLabelEnum.Proposed,
  [ChangeRequestStatusIntEnum.Approved]: ChangeRequestStatusLabelEnum.Approved,
  [ChangeRequestStatusIntEnum.Rejected]: ChangeRequestStatusLabelEnum.Rejected,
  [ChangeRequestStatusIntEnum.Committing]: ChangeRequestStatusLabelEnum.Committing,
  [ChangeRequestStatusIntEnum.Committed]: ChangeRequestStatusLabelEnum.Committed,
  [ChangeRequestStatusIntEnum.Verified]: ChangeRequestStatusLabelEnum.Verified,
  [ChangeRequestStatusIntEnum.Mismatch]: ChangeRequestStatusLabelEnum.Mismatch,
  [ChangeRequestStatusIntEnum.Failed]: ChangeRequestStatusLabelEnum.Failed,
  [ChangeRequestStatusIntEnum.Undone]: ChangeRequestStatusLabelEnum.Undone,
  [ChangeRequestStatusIntEnum.Expired]: ChangeRequestStatusLabelEnum.Expired,
  [ChangeRequestStatusIntEnum.NeedsHuman]: ChangeRequestStatusLabelEnum.NeedsHuman,
};

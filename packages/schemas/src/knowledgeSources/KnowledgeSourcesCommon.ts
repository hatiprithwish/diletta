export enum KnowledgeSourceTypeIntEnum {
  Sitemap = 1,
  Url = 2,
  Upload = 3,
}

export enum KnowledgeSourceTypeLabelEnum {
  Sitemap = "Sitemap",
  Url = "URL",
  Upload = "Upload",
}

export const KNOWLEDGE_SOURCE_TYPE_LABEL_MAP: Record<
  KnowledgeSourceTypeIntEnum,
  KnowledgeSourceTypeLabelEnum
> = {
  [KnowledgeSourceTypeIntEnum.Sitemap]: KnowledgeSourceTypeLabelEnum.Sitemap,
  [KnowledgeSourceTypeIntEnum.Url]: KnowledgeSourceTypeLabelEnum.Url,
  [KnowledgeSourceTypeIntEnum.Upload]: KnowledgeSourceTypeLabelEnum.Upload,
};

export enum KnowledgeSourceSyncFrequencyIntEnum {
  Manual = 1,
  Daily = 2,
  Weekly = 3,
}

export enum KnowledgeSourceSyncFrequencyLabelEnum {
  Manual = "Manual",
  Daily = "Daily",
  Weekly = "Weekly",
}

export const KNOWLEDGE_SOURCE_SYNC_FREQUENCY_LABEL_MAP: Record<
  KnowledgeSourceSyncFrequencyIntEnum,
  KnowledgeSourceSyncFrequencyLabelEnum
> = {
  [KnowledgeSourceSyncFrequencyIntEnum.Manual]: KnowledgeSourceSyncFrequencyLabelEnum.Manual,
  [KnowledgeSourceSyncFrequencyIntEnum.Daily]: KnowledgeSourceSyncFrequencyLabelEnum.Daily,
  [KnowledgeSourceSyncFrequencyIntEnum.Weekly]: KnowledgeSourceSyncFrequencyLabelEnum.Weekly,
};

export enum KnowledgeSourceStatusIntEnum {
  Active = 1,
  Syncing = 2,
  Failed = 3,
  Paused = 4,
}

export enum KnowledgeSourceStatusLabelEnum {
  Active = "Active",
  Syncing = "Syncing",
  Failed = "Failed",
  Paused = "Paused",
}

export const KNOWLEDGE_SOURCE_STATUS_LABEL_MAP: Record<
  KnowledgeSourceStatusIntEnum,
  KnowledgeSourceStatusLabelEnum
> = {
  [KnowledgeSourceStatusIntEnum.Active]: KnowledgeSourceStatusLabelEnum.Active,
  [KnowledgeSourceStatusIntEnum.Syncing]: KnowledgeSourceStatusLabelEnum.Syncing,
  [KnowledgeSourceStatusIntEnum.Failed]: KnowledgeSourceStatusLabelEnum.Failed,
  [KnowledgeSourceStatusIntEnum.Paused]: KnowledgeSourceStatusLabelEnum.Paused,
};

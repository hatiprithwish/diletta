import z from "zod";

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

export enum KnowledgeSourceSortColumn {
  CreatedAt = "createdAt",
  LastSyncedAt = "lastSyncedAt",
}

export const ZKnowledgeSourceSortColumn = z.enum(KnowledgeSourceSortColumn);

// DEV_NOTE: Why a knowledge source request was refused for its state, not its input. The route answers 409.
//   AlreadySyncing: a sync is running (a second one would race it on the same documents).
//   Paused: a paused source never syncs until it is resumed.
//   NotUploadSource: files are uploaded to an upload source only.
//   NotWebSource: only a web source (sitemap, url) has a sync frequency.
//   UnreadableFile: an upload whose bytes don't match its type (a .pdf that isn't a PDF); the route answers 400.
export enum KnowledgeSourceFailureEnum {
  AlreadySyncing = "AlreadySyncing",
  Paused = "Paused",
  NotUploadSource = "NotUploadSource",
  NotWebSource = "NotWebSource",
  UnreadableFile = "UnreadableFile",
}

// DEV_NOTE: A web source's URL: http(s) on a public domain name, on the default port. IP literals, single-label hosts
// (localhost) and explicit ports are refused, so a source can't point the crawler at an address or a service instead
// of a site.
export const KNOWLEDGE_SOURCE_URL_MAX_LENGTH = 2048;
export const ZKnowledgeSourceUrl = z
  .url({ protocol: /^https?$/, hostname: z.regexes.domain })
  .max(KNOWLEDGE_SOURCE_URL_MAX_LENGTH)
  .refine((url) => new URL(url).port === "", { message: "URL must use the default port" });

// Create Knowledge Source Body
// DEV_NOTE: Web sources (sitemap, url) need a url and a sync frequency; uploads have neither (CHK_knowledge_sources_*)
export const ZKnowledgeSourceBase = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(KnowledgeSourceTypeIntEnum.Sitemap),
    url: ZKnowledgeSourceUrl,
    syncFrequency: z.enum(KnowledgeSourceSyncFrequencyIntEnum),
  }),
  z.object({
    type: z.literal(KnowledgeSourceTypeIntEnum.Url),
    url: ZKnowledgeSourceUrl,
    syncFrequency: z.enum(KnowledgeSourceSyncFrequencyIntEnum),
  }),
  z.object({
    type: z.literal(KnowledgeSourceTypeIntEnum.Upload),
  }),
]);
export type KnowledgeSourceBase = z.infer<typeof ZKnowledgeSourceBase>;

// Whole Knowledge Source Body — DB shape (enums stored as integers)
// DEV_NOTE: id, companyId, createdBy and updatedBy are internal bigint ids — used by DAL/Repo only, NEVER sent to a
// client
export const ZKnowledgeSource = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  type: z.enum(KnowledgeSourceTypeIntEnum),
  url: z.string().nullable(),
  syncFrequency: z.enum(KnowledgeSourceSyncFrequencyIntEnum).nullable(),
  status: z.enum(KnowledgeSourceStatusIntEnum),
  lastSyncedAt: z.date().nullable(),
  syncRunId: z.string().nullable(),
  syncHeartbeatAt: z.date().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type KnowledgeSource = z.infer<typeof ZKnowledgeSource>;

// API response shape — includes both int and label; internal ids (and the sync run token) are structurally omitted,
// publicId is client-facing
export type KnowledgeSourceWithStatus = Omit<
  KnowledgeSource,
  "id" | "companyId" | "createdBy" | "updatedBy" | "syncRunId"
> & {
  knowledgeSourceStatus: KnowledgeSourceStatusIntEnum;
  knowledgeSourceStatusLabel: KnowledgeSourceStatusLabelEnum;
  typeLabel: KnowledgeSourceTypeLabelEnum;
  syncFrequencyLabel: KnowledgeSourceSyncFrequencyLabelEnum | null;
};

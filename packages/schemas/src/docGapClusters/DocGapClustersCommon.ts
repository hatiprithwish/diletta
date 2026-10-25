import { z } from "zod";

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

// Whole Doc Gap Cluster Body — DB shape (enums stored as integers)
// DEV_NOTE: id, companyId and answeredByDocumentId are internal bigint ids — used by DAL/Repo only, NEVER sent to a
// client. The centroid (halfvec) is the clustering's own (M5-6) and is never read by the dashboard, so it isn't here.
export const ZDocGapCluster = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  label: z.string(),
  questionCount: z.number().int(),
  status: z.enum(DocGapClusterStatusIntEnum),
  answeredByDocumentId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type DocGapCluster = z.infer<typeof ZDocGapCluster>;

// DEV_NOTE: The Knowledge page's tabs for the questions it couldn't answer (M4-7), one status each. An admin closes an
// Open group with the document that answers it (Answered) or dismisses it; neither is reopened by hand. Removing the
// document that answered a group reopens it (KnowledgeDocumentFilesProvider), since nothing answers it any more.
export enum DocGapClusterListTabEnum {
  Open = "open",
  Answered = "answered",
  Dismissed = "dismissed",
}

export const ZDocGapClusterListTab = z.enum(DocGapClusterListTabEnum);

// DEV_NOTE: The count behind each tab, keyed by the tab itself
export type DocGapClusterTabCounts = Record<DocGapClusterListTabEnum, number>;

export const DOC_GAP_CLUSTER_TAB_STATUS: Record<
  DocGapClusterListTabEnum,
  DocGapClusterStatusIntEnum
> = {
  [DocGapClusterListTabEnum.Open]: DocGapClusterStatusIntEnum.Open,
  [DocGapClusterListTabEnum.Answered]: DocGapClusterStatusIntEnum.Answered,
  [DocGapClusterListTabEnum.Dismissed]: DocGapClusterStatusIntEnum.Dismissed,
};

// DEV_NOTE: Most-asked first by default (the design lists 14, 9, 6 questions)
export enum DocGapClusterSortColumn {
  QuestionCount = "questionCount",
  CreatedAt = "createdAt",
  UpdatedAt = "updatedAt",
}

export const ZDocGapClusterSortColumn = z.enum(DocGapClusterSortColumn);

// DEV_NOTE: Rows per page on the Knowledge page, and how many of a group's questions it shows (the newest)
export const DOC_GAP_CLUSTERS_PAGE_SIZE = 20;
export const DOC_GAP_SAMPLE_QUESTIONS_MAX = 3;

// DEV_NOTE: Why an answer or dismiss changed nothing (409): the group is no longer Open (someone closed it first)
export enum DocGapClusterUpdateFailureEnum {
  NotOpen = "NotOpen",
}

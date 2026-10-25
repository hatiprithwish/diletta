import type { ApiResponse, TotalRecordsResponse } from "../common";
import type { DocGapCluster, DocGapClusterTabCounts } from "./DocGapClustersCommon";

// DEV_NOTE: One group as the Knowledge page reads it (M4-7), with internal ids (the Repo drops them). The answering
// document and its source are left joins (no DB foreign keys); latestQuestionAt = its newest question's created_at.
export interface DocGapClusterRow {
  id: string;
  publicId: string;
  label: string;
  questionCount: number;
  status: DocGapCluster["status"];
  createdAt: Date;
  updatedAt: Date;
  latestQuestionAt: Date | null;
  documentPublicId: string | null;
  documentTitle: string | null;
  documentSourceUrl: string | null;
  sourcePublicId: string | null;
  sourceName: string | null;
}

export interface DocGapClusterRowDALResponse extends ApiResponse {
  docGapCluster?: DocGapClusterRow;
}

export interface DocGapClusterRowsDALResponse extends ApiResponse {
  docGapClusters?: DocGapClusterRow[];
}

// DAL results carry the raw DB row (internal ids). The Repo maps them to API responses.
export interface DocGapClusterDALResponse extends ApiResponse {
  docGapCluster?: DocGapCluster;
}

// DEV_NOTE: Every tab's count; totalRecords = all of them
export interface DocGapClusterTabCountsDALResponse extends TotalRecordsResponse {
  tabCounts?: DocGapClusterTabCounts;
}

// DEV_NOTE: Each group's sample questions, newest first, keyed by the group's internal id (a group with none has no key)
export interface DocGapSampleQuestionsDALResponse extends ApiResponse {
  sampleQuestions?: Record<string, string[]>;
}

export interface ReopenDocGapClustersDALResponse extends ApiResponse {
  reopenedCount?: number;
}

import type { ApiResponse } from "../common";
import type {
  DocGapClusterStatusIntEnum,
  DocGapClusterStatusLabelEnum,
  DocGapClusterTabCounts,
  DocGapClusterUpdateFailureEnum,
} from "./DocGapClustersCommon";

// DEV_NOTE: The document that answered a group, and its source, so the page can link to it (M4-7's Done-when).
// sourceUrl is the page's address for a web source, null for an upload.
export interface DocGapClusterAnswer {
  documentPublicId: string;
  title: string | null;
  sourceUrl: string | null;
  knowledgeSource: {
    publicId: string;
    name: string;
  };
}

// DEV_NOTE: One group of questions the assistant couldn't answer (M4-7). Status Enum Pattern for its status.
// sampleQuestions = the newest DOC_GAP_SAMPLE_QUESTIONS_MAX of its questions, already rewritten without personal
// details (doc_gaps.question_generic); latestQuestionAt null = none left (they moved to another group). answeredBy is
// set while Answered.
export interface DocGapClusterListItem {
  publicId: string;
  label: string;
  questionCount: number;
  docGapClusterStatus: DocGapClusterStatusIntEnum;
  docGapClusterStatusLabel: DocGapClusterStatusLabelEnum;
  latestQuestionAt: string | null;
  sampleQuestions: string[];
  answeredBy: DocGapClusterAnswer | null;
  createdAt: string;
  updatedAt: string;
}

export interface GetDocGapClustersApiResponse extends ApiResponse {
  docGapClusters?: DocGapClusterListItem[];
  totalRecords?: number;
  tabCounts?: DocGapClusterTabCounts;
}

// DEV_NOTE: POST …/answer, …/dismiss: the group as it stands after. failure set (409) = it is no longer Open
export interface UpdateDocGapClusterApiResponse extends ApiResponse {
  docGapCluster?: DocGapClusterListItem;
  failure?: DocGapClusterUpdateFailureEnum;
}

import type { PageDALRequest } from "../common";
import type {
  DocGapCluster,
  DocGapClusterListTabEnum,
  DocGapClusterSortColumn,
} from "./DocGapClustersCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
export type CountDocGapClustersDALRequest = Pick<DocGapCluster, "companyId">;

export type GetDocGapClustersDALRequest = CountDocGapClustersDALRequest &
  PageDALRequest & { tab: DocGapClusterListTabEnum; sortColumn: DocGapClusterSortColumn };

// DEV_NOTE: One group by its public id within the company. isForUpdate (every write) locks the group row only.
export type FindDocGapClusterDALRequest = Pick<DocGapCluster, "companyId" | "publicId"> & {
  isForUpdate: boolean;
};

// DEV_NOTE: The newest perCluster questions of each group (the Repo passes DOC_GAP_SAMPLE_QUESTIONS_MAX)
export type GetDocGapSampleQuestionsDALRequest = Pick<DocGapCluster, "companyId"> & {
  clusterIds: string[];
  perCluster: number;
};

// DEV_NOTE: Open → Answered with the document that answers it; the DAL matches status Open. The Repo resolves the
// document in the company and locks it first (no DB foreign keys), so the DAL doesn't check it again.
export type AnswerDocGapClusterDALRequest = Pick<DocGapCluster, "companyId" | "id"> & {
  answeredByDocumentId: string;
};

// DEV_NOTE: Open → Dismissed; the DAL matches status Open
export type DismissDocGapClusterDALRequest = Pick<DocGapCluster, "companyId" | "id">;

// DEV_NOTE: The groups these documents answered go back to Open with no document, in the transaction that removes the
// documents (KnowledgeDocumentFilesProvider)
export type ReopenDocGapClustersDALRequest = Pick<DocGapCluster, "companyId"> & {
  knowledgeDocumentIds: string[];
};

// DEV_NOTE: The closest group a new question may join (M5-6), locked: Open and Dismissed only, so an Answered group's
// document having failed starts a new group
export type FindNearestDocGapClusterDALRequest = Pick<DocGapCluster, "companyId" | "chatbotId"> & {
  embedding: number[];
};

export type LockDocGapClusteringDALRequest = Pick<DocGapCluster, "companyId" | "chatbotId">;

export type CreateDocGapClusterDALRequest = Pick<
  DocGapCluster,
  "companyId" | "chatbotId" | "label"
> & { centroid: number[] };

// DEV_NOTE: One more question in the group, with its new centroid
export type GrowDocGapClusterDALRequest = Pick<
  DocGapCluster,
  "companyId" | "id" | "questionCount"
> & { centroid: number[] };

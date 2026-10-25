import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import DocGapClustersDAL from "@/data-access-layer/DocGapClustersDAL";
import KnowledgeDocumentsDAL from "@/data-access-layer/KnowledgeDocumentsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

// DEV_NOTE: Tenant Repo — the questions the assistant couldn't answer, grouped, as the Knowledge page works them (M4-7):
// the list with its tab counts and each group's newest questions, Answer (the document that closes the group: uploaded
// or picked by the admin) and Dismiss. Both start from Open under the group's row lock and end it (no reopen by hand;
// removing the answering document reopens it, KnowledgeDocumentFilesProvider). One withTenant per method; the answer
// is read back in the same transaction. The clustering that writes the groups and their questions is M5-6.
export default class DocGapClustersRepo {
  private db: NodePgDatabase;
  private dal: DocGapClustersDAL;
  private documentsDal: KnowledgeDocumentsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new DocGapClustersDAL();
    this.documentsDal = new KnowledgeDocumentsDAL();
  }

  // DEV_NOTE: Status Enum Pattern — status as int + label; internal ids dropped. answeredBy is set while Answered.
  // An Answered group whose document didn't join should never happen (removing a document reopens its groups, and
  // Answer locks the document), so it is logged rather than hidden silently.
  private toListItem(
    row: Schemas.DocGapClusterRow,
    sampleQuestions: string[],
  ): Schemas.DocGapClusterListItem {
    const { documentPublicId, sourcePublicId, sourceName } = row;
    const isAnswered = row.status === Schemas.DocGapClusterStatusIntEnum.Answered;
    const answeredBy =
      isAnswered && documentPublicId !== null && sourcePublicId !== null && sourceName !== null
        ? {
            documentPublicId,
            title: row.documentTitle,
            sourceUrl: row.documentSourceUrl,
            knowledgeSource: { publicId: sourcePublicId, name: sourceName },
          }
        : null;
    if (isAnswered && answeredBy === null) {
      AppLogger.warn({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.GetDocGapClusters,
        message: "Answered doc gap cluster has no answering document",
        metadata: { publicId: row.publicId },
      });
    }
    return {
      publicId: row.publicId,
      label: row.label,
      questionCount: row.questionCount,
      docGapClusterStatus: row.status,
      docGapClusterStatusLabel: Schemas.DOC_GAP_CLUSTER_STATUS_LABEL_MAP[row.status],
      latestQuestionAt: row.latestQuestionAt?.toISOString() ?? null,
      sampleQuestions,
      answeredBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getDocGapClusters(
    params: Schemas.GetDocGapClustersApiRequest & { companyId: string },
  ): Promise<Schemas.GetDocGapClustersApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetDocGapClustersApiResponse> => {
        const tab = params.tab ?? Schemas.DocGapClusterListTabEnum.Open;
        const page = await this.dal.getDocGapClusters(tx, {
          companyId,
          tab,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.DocGapClusterSortColumn.QuestionCount,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!page.isSuccess || !page.docGapClusters) {
          return { isSuccess: false, message: page.message };
        }
        const rows = page.docGapClusters;

        const counted = await this.dal.getDocGapClustersCount(tx, { companyId });
        if (!counted.isSuccess || !counted.tabCounts) {
          return { isSuccess: false, message: counted.message };
        }
        const { tabCounts } = counted;

        const samples = await this.dal.getDocGapSampleQuestions(tx, {
          companyId,
          clusterIds: rows.map((row) => row.id),
          perCluster: Schemas.DOC_GAP_SAMPLE_QUESTIONS_MAX,
        });
        if (!samples.isSuccess || !samples.sampleQuestions) {
          return { isSuccess: false, message: samples.message };
        }
        const sampleQuestions = samples.sampleQuestions;

        return {
          isSuccess: true,
          message: "Doc gap clusters fetched successfully",
          docGapClusters: rows.map((row) => this.toListItem(row, sampleQuestions[row.id] ?? [])),
          totalRecords: tabCounts[tab],
          tabCounts,
        };
      },
    );
  }

  // DEV_NOTE: Open → Answered by a document of any source in the company (unknown group or document → 404; not Open →
  // failure NotOpen, 409, nothing written)
  async answerDocGapCluster(
    params: Schemas.AnswerDocGapClusterApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.UpdateDocGapClusterApiResponse> {
    const { companyId } = params;
    const result = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.UpdateDocGapClusterApiResponse> => {
        const open = await this.lockOpenCluster(tx, params);
        if (!open.isSuccess) return open.response;

        // DEV_NOTE: Locked until the commit (FOR KEY SHARE). Otherwise a delete of the document committing meanwhile
        // would reopen nothing (its snapshot still shows this group unanswered) and leave the group pointing at a
        // missing document; a delete already under way makes this wait, then answer 404
        const document = await this.documentsDal.getCompanyKnowledgeDocument(tx, {
          companyId,
          publicId: params.documentPublicId,
          isForKeyShare: true,
        });
        if (!document.isSuccess || !document.knowledgeDocument) {
          return { isSuccess: false, message: document.message, isNotFound: document.isNotFound };
        }

        const answered = await this.dal.answerDocGapCluster(tx, {
          companyId,
          id: open.row.id,
          answeredByDocumentId: document.knowledgeDocument.id,
        });
        if (!answered.isSuccess) {
          throw new TenantRollbackError(answered.message ?? "Doc gap cluster not answered");
        }
        return await this.readBack(tx, params);
      },
    );
    return this.logRefusal(result, params, Schemas.LogAction.AnswerDocGapCluster);
  }

  // DEV_NOTE: Open → Dismissed (unknown → 404; not Open → failure NotOpen, 409, nothing written)
  async dismissDocGapCluster(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.UpdateDocGapClusterApiResponse> {
    const { companyId } = params;
    const result = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.UpdateDocGapClusterApiResponse> => {
        const open = await this.lockOpenCluster(tx, params);
        if (!open.isSuccess) return open.response;

        const dismissed = await this.dal.dismissDocGapCluster(tx, { companyId, id: open.row.id });
        if (!dismissed.isSuccess) {
          throw new TenantRollbackError(dismissed.message ?? "Doc gap cluster not dismissed");
        }
        return await this.readBack(tx, params);
      },
    );
    return this.logRefusal(result, params, Schemas.LogAction.DismissDocGapCluster);
  }

  // DEV_NOTE: The group locked (unknown → 404) and checked Open (else failure NotOpen)
  private async lockOpenCluster(
    tx: Tx,
    params: { companyId: string; publicId: string },
  ): Promise<
    | { isSuccess: true; row: Schemas.DocGapClusterRow }
    | { isSuccess: false; response: Schemas.UpdateDocGapClusterApiResponse }
  > {
    const found = await this.dal.getDocGapCluster(tx, {
      companyId: params.companyId,
      publicId: params.publicId,
      isForUpdate: true,
    });
    if (!found.isSuccess || !found.docGapCluster) {
      return {
        isSuccess: false,
        response: { isSuccess: false, message: found.message, isNotFound: found.isNotFound },
      };
    }
    if (found.docGapCluster.status !== Schemas.DocGapClusterStatusIntEnum.Open) {
      return {
        isSuccess: false,
        response: {
          isSuccess: false,
          message: "Only an open group of questions can change",
          failure: Schemas.DocGapClusterUpdateFailureEnum.NotOpen,
        },
      };
    }
    return { isSuccess: true, row: found.docGapCluster };
  }

  // DEV_NOTE: The group as it stands after the write, in the write's transaction. A failed read rolls the write back, so
  // a success always carries the group.
  private async readBack(
    tx: Tx,
    params: { companyId: string; publicId: string },
  ): Promise<Schemas.UpdateDocGapClusterApiResponse> {
    const found = await this.dal.getDocGapCluster(tx, { ...params, isForUpdate: false });
    if (!found.isSuccess || !found.docGapCluster) {
      throw new TenantRollbackError(found.message ?? "Doc gap cluster didn't load");
    }
    const row = found.docGapCluster;
    const samples = await this.dal.getDocGapSampleQuestions(tx, {
      companyId: params.companyId,
      clusterIds: [row.id],
      perCluster: Schemas.DOC_GAP_SAMPLE_QUESTIONS_MAX,
    });
    if (!samples.isSuccess || !samples.sampleQuestions) {
      throw new TenantRollbackError(samples.message ?? "Doc gap questions didn't load");
    }
    return {
      isSuccess: true,
      message: "Doc gap cluster updated successfully",
      docGapCluster: this.toListItem(row, samples.sampleQuestions[row.id] ?? []),
    };
  }

  private logRefusal(
    result: Schemas.UpdateDocGapClusterApiResponse,
    params: { companyId: string; publicId: string },
    action: Schemas.LogAction,
  ): Schemas.UpdateDocGapClusterApiResponse {
    if (!result.isSuccess && result.failure) {
      AppLogger.warn({
        category: Schemas.LogCategory.Repo,
        action,
        message: "Doc gap cluster not changed",
        metadata: {
          companyId: params.companyId,
          publicId: params.publicId,
          failure: result.failure,
        },
      });
    }
    return result;
  }
}

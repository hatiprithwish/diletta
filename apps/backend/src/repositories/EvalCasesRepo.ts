import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

// DEV_NOTE: Tenant Repo — test cases as the Tests page works them (M4-8): the Cases tab (the company's cases and the
// platform's, with each one's newest result), one case with its conversation and rubric, New case and Edit (v1 bodies:
// Schemas.readEvalCaseBody / toEvalCaseV1), and turning a case on or off. Only the company's own cases change: a
// platform case reads, and an edit of one answers 404. Case text never reaches a log. No event: the audit log is M4-9.
export default class EvalCasesRepo {
  private db: NodePgDatabase;
  private evalCasesDal: EvalCasesDAL;
  private chatbotsDal: ChatbotsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.evalCasesDal = new EvalCasesDAL();
    this.chatbotsDal = new ChatbotsDAL();
  }

  private toListItem(
    row: Schemas.DashboardEvalCaseRow,
    latest: Schemas.LatestEvalCaseResult | undefined,
  ): Schemas.EvalCaseListItem {
    return {
      publicId: row.publicId,
      name: row.name,
      isSafety: row.isSafety,
      isActive: row.isActive,
      isPlatform: row.companyId === null,
      chatbotName: row.chatbotName,
      latestResult: latest
        ? {
            evalRunPublicId: latest.evalRunPublicId,
            hasPassed: Schemas.hasEvalCasePassed(latest.passedAttemptCount, latest.k),
            attemptCount: latest.attemptCount,
            passedAttemptCount: latest.passedAttemptCount,
            createdAt: latest.createdAt.toISOString(),
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // DEV_NOTE: The newest result of each case, keyed by internal case id
  private async latestResults(
    tx: Tx,
    companyId: string,
    evalCaseIds: string[],
  ): Promise<
    { isSuccess: true; byCase: Map<string, Schemas.LatestEvalCaseResult> } | Schemas.ApiResponse
  > {
    const latest = await this.evalCasesDal.getLatestEvalCaseResults(tx, { companyId, evalCaseIds });
    if (!latest.isSuccess) return { isSuccess: false, message: latest.message };
    return {
      isSuccess: true,
      byCase: new Map((latest.results ?? []).map((result) => [result.evalCaseId, result])),
    };
  }

  async getEvalCases(
    params: Schemas.GetEvalCasesApiRequest & { companyId: string },
  ): Promise<Schemas.GetEvalCasesApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetEvalCasesApiResponse> => {
        let chatbotId: string | null = null;
        if (params.botId !== undefined) {
          const chatbot = await this.chatbotsDal.getChatbotDetails(tx, {
            companyId,
            publicId: params.botId,
          });
          if (!chatbot.isSuccess || !chatbot.chatbot) {
            return { isSuccess: false, message: chatbot.message, isNotFound: chatbot.isNotFound };
          }
          chatbotId = chatbot.chatbot.id;
        }

        const page = await this.evalCasesDal.getEvalCases(tx, {
          companyId,
          chatbotId,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.EvalCaseSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!page.isSuccess) return { isSuccess: false, message: page.message };
        const rows = page.evalCases ?? [];

        const counted = await this.evalCasesDal.getEvalCasesCount(tx, { companyId, chatbotId });
        if (!counted.isSuccess) return { isSuccess: false, message: counted.message };

        const latest = await this.latestResults(
          tx,
          companyId,
          rows.map((row) => row.id),
        );
        if (!("byCase" in latest)) return latest;

        return {
          isSuccess: true,
          message: "Eval cases fetched successfully",
          evalCases: rows.map((row) => this.toListItem(row, latest.byCase.get(row.id))),
          totalRecords: counted.totalRecords ?? 0,
        };
      },
    );
  }

  async getEvalCase(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetEvalCaseApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const found = await this.evalCasesDal.getEvalCase(tx, params);
      if (!found.isSuccess || !found.evalCase) {
        return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
      }
      return await this.withDetail(tx, params.companyId, found.evalCase);
    });
  }

  // DEV_NOTE: New case: a v1 case for botId's chatbot, else the company's default one (unknown, or no default → 404).
  // Saved active, never a safety case.
  async createEvalCase(
    params: Schemas.CreateEvalCaseApiRequest & { companyId: string },
  ): Promise<Schemas.WriteEvalCaseApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.WriteEvalCaseApiResponse> => {
        const chatbot =
          params.botId !== undefined
            ? await this.chatbotsDal.getChatbotDetails(tx, { companyId, publicId: params.botId })
            : await this.chatbotsDal.getDefaultChatbot(tx, { companyId });
        if (!chatbot.isSuccess || !chatbot.chatbot) {
          return { isSuccess: false, message: chatbot.message, isNotFound: chatbot.isNotFound };
        }

        const created = await this.evalCasesDal.createEvalCase(tx, {
          companyId,
          chatbotId: chatbot.chatbot.id,
          name: params.name,
          ...Schemas.toEvalCaseV1({ messages: params.messages, rubric: params.rubric }),
        });
        if (!created.isSuccess || !created.evalCase) {
          return { isSuccess: false, message: created.message, isNotFound: created.isNotFound };
        }

        const found = await this.evalCasesDal.getEvalCase(tx, {
          companyId,
          publicId: created.evalCase.publicId,
        });
        if (!found.isSuccess || !found.evalCase) {
          throw new TenantRollbackError(found.message ?? "Eval case not read back");
        }
        return await this.writtenDetail(tx, companyId, found.evalCase);
      },
    );
  }

  // DEV_NOTE: Edit or turn on / off the company's own case, under its row lock (a platform or another company's case →
  // 404). A new conversation or rubric is merged into the stored v1 body; a body this page can't read refuses them with
  // failure NotEditable (409, nothing written), while isActive still changes.
  async updateEvalCase(
    params: Schemas.UpdateEvalCaseApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.WriteEvalCaseApiResponse> {
    const { companyId } = params;
    const result: Schemas.WriteEvalCaseApiResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.WriteEvalCaseApiResponse> => {
        const found = await this.evalCasesDal.getEvalCase(tx, {
          companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.evalCase) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const row = found.evalCase;

        let body: Schemas.EvalCaseBody | undefined;
        if (params.messages !== undefined || params.rubric !== undefined) {
          const stored = Schemas.readEvalCaseBody(row.input, row.expectations);
          if (!stored) {
            return {
              isSuccess: false,
              message: "This case's conversation can't be edited here",
              failure: Schemas.EvalCaseUpdateFailureEnum.NotEditable,
            };
          }
          body = {
            messages: params.messages ?? stored.messages,
            rubric: params.rubric ?? stored.rubric,
          };
        }

        const updated = await this.evalCasesDal.updateEvalCase(tx, {
          companyId,
          id: row.id,
          name: params.name,
          isActive: params.isActive,
          ...(body ? Schemas.toEvalCaseV1(body) : {}),
        });
        if (!updated.isSuccess || !updated.evalCase) {
          throw new TenantRollbackError(updated.message ?? "Eval case not updated");
        }

        const reread = await this.evalCasesDal.getEvalCase(tx, {
          companyId,
          publicId: params.publicId,
        });
        if (!reread.isSuccess || !reread.evalCase) {
          throw new TenantRollbackError(reread.message ?? "Eval case not read back");
        }
        return await this.writtenDetail(tx, companyId, reread.evalCase);
      },
    );
    if (!result.isSuccess && result.failure) {
      AppLogger.warn({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.UpdateEvalCase,
        message: "Eval case not changed",
        metadata: { companyId, publicId: params.publicId, failure: result.failure },
      });
    }
    return result;
  }

  // DEV_NOTE: A write's answer, read in its own transaction: a failed read rolls the write back, so the client never
  // sees an error for a case that was saved
  private async writtenDetail(
    tx: Tx,
    companyId: string,
    row: Schemas.DashboardEvalCaseRow,
  ): Promise<Schemas.WriteEvalCaseApiResponse> {
    const detail = await this.withDetail(tx, companyId, row);
    if (!detail.isSuccess)
      throw new TenantRollbackError(detail.message ?? "Eval case not read back");
    return detail;
  }

  // DEV_NOTE: The detail: the list item, its newest result and its conversation and rubric (null = a shape the page
  // can't show, readEvalCaseBody)
  private async withDetail(
    tx: Tx,
    companyId: string,
    row: Schemas.DashboardEvalCaseRow,
  ): Promise<Schemas.GetEvalCaseApiResponse> {
    const latest = await this.latestResults(tx, companyId, [row.id]);
    if (!("byCase" in latest)) return latest;
    return {
      isSuccess: true,
      message: "Eval case fetched successfully",
      evalCase: {
        ...this.toListItem(row, latest.byCase.get(row.id)),
        body: Schemas.readEvalCaseBody(row.input, row.expectations),
      },
    };
  }
}

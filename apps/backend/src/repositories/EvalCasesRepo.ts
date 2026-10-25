import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

// DEV_NOTE: Tenant Repo — test cases as the Tests page works them (M4-8): the Cases tab (the company's cases and the
// platform's, with each one's newest result), one case with its conversation and rubric, New case and Edit (v1 bodies:
// Schemas.readEvalCaseBody / toEvalCaseV1), and turning a case on or off. Only the company's own cases change: a
// platform case reads, and an edit of one answers 404. Case text never reaches a log, nor the audit row each write
// records (M4-9: the case's name only).
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
            hasPassed: Schemas.evalCaseRunResult({
              passedAttemptCount: latest.passedAttemptCount,
              attemptCount: latest.attemptCount,
              k: latest.k,
              runStatus: latest.evalRunStatus,
            }),
            attemptCount: latest.attemptCount,
            passedAttemptCount: latest.passedAttemptCount,
            createdAt: latest.createdAt.toISOString(),
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // DEV_NOTE: The newest result of each case, keyed by internal case id; chatbotId set = only that chatbot's runs
  private async latestResults(
    tx: Tx,
    params: Schemas.GetLatestEvalCaseResultsDALRequest,
  ): Promise<
    { isSuccess: true; byCase: Map<string, Schemas.LatestEvalCaseResult> } | Schemas.ApiResponse
  > {
    const latest = await this.evalCasesDal.getLatestEvalCaseResults(tx, params);
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

        const latest = await this.latestResults(tx, {
          companyId,
          chatbotId,
          evalCaseIds: rows.map((row) => row.id),
        });
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
    params: Schemas.CreateEvalCaseApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.WriteEvalCaseApiResponse>> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.WriteEvalCaseApiResponse>> => {
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
        const outboxId = await this.audit(
          tx,
          params,
          found.evalCase,
          Schemas.AuditEntityActionEnum.Created,
        );
        return {
          ...(await this.writtenDetail(tx, companyId, found.evalCase)),
          outboxIds: [outboxId],
        };
      },
    );
  }

  // DEV_NOTE: Edit or turn on / off the company's own case, under its row lock (a platform or another company's case →
  // 404). A new conversation or rubric is merged into the stored v1 body; a body this page can't read refuses a new
  // conversation or rubric with NotEditable (409, nothing in the request is written); an isActive-only edit still works.
  async updateEvalCase(
    params: Schemas.UpdateEvalCaseApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.WriteEvalCaseApiResponse>> {
    const { companyId } = params;
    const result: Schemas.WithOutboxIds<Schemas.WriteEvalCaseApiResponse> = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.WriteEvalCaseApiResponse>> => {
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
          const merged: Schemas.EvalCaseBody = {
            messages: params.messages ?? stored.messages,
            rubric: params.rubric ?? stored.rubric,
          };
          // DEV_NOTE: The Edit form sends the whole case, so a body equal to the stored one is no change: not written,
          // not audited
          if (Utility.stableStringify(merged) !== Utility.stableStringify(stored)) body = merged;
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
        const after = reread.evalCase;

        // DEV_NOTE: Audited by what changed: a new name, conversation or rubric is Updated, on / off its own row
        const actions: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.EvalCase>[] = [];
        if (after.name !== row.name || body !== undefined) {
          actions.push(Schemas.AuditEntityActionEnum.Updated);
        }
        if (after.isActive !== row.isActive) {
          actions.push(
            after.isActive
              ? Schemas.AuditEntityActionEnum.TurnedOn
              : Schemas.AuditEntityActionEnum.TurnedOff,
          );
        }
        const outboxIds: string[] = [];
        for (const action of actions) {
          outboxIds.push(await this.audit(tx, params, after, action));
        }
        return { ...(await this.writtenDetail(tx, companyId, after)), outboxIds };
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

  // DEV_NOTE: The admin's audit row (M4-9) in the write's transaction, labelled with the case's name (never its text); a
  // failure rolls the write back
  private async audit(
    tx: Tx,
    params: { companyId: string; adminId: string },
    row: Schemas.DashboardEvalCaseRow,
    entityAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.EvalCase>,
  ): Promise<string> {
    return await recordAuditOrRollback(tx, {
      companyId: params.companyId,
      actor: adminAuditActor(params.adminId),
      entityType: Schemas.AuditEntityTypeEnum.EvalCase,
      entityAction,
      entity: row,
      label: row.name,
    });
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

  // DEV_NOTE: The detail: the list item, its newest result (any chatbot's run) and its conversation and rubric. A platform
  // case never shows its body: its prompts and pass criteria gate publishing (M5-4), and a company that could read them
  // could tune a config to the test. body is also null for a shape the page can't show (readEvalCaseBody).
  private async withDetail(
    tx: Tx,
    companyId: string,
    row: Schemas.DashboardEvalCaseRow,
  ): Promise<Schemas.GetEvalCaseApiResponse> {
    const latest = await this.latestResults(tx, {
      companyId,
      chatbotId: null,
      evalCaseIds: [row.id],
    });
    if (!("byCase" in latest)) return latest;
    return {
      isSuccess: true,
      message: "Eval case fetched successfully",
      evalCase: {
        ...this.toListItem(row, latest.byCase.get(row.id)),
        body: row.companyId === null ? null : Schemas.readEvalCaseBody(row.input, row.expectations),
      },
    };
  }
}

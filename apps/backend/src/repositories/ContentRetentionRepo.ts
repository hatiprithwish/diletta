import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getAgentByName } from "agents";
import Constants from "@/config/Constants";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import DocGapsDAL from "@/data-access-layer/DocGapsDAL";
import FeedbackDAL from "@/data-access-layer/FeedbackDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import ToolCallsDAL from "@/data-access-layer/ToolCallsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import FileStorageProvider from "@/providers/fileStorage";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The retention purge (M6-1): a chat past last_activity_at + its company's days keeps only counts, statuses,
// costs and doc gap text. Companies are listed across the platform (withPlatform); each company's reads and each chat's
// writes are its own (withTenant). Companies take a batch in turn until no chat is due or the time budget is used up. A
// batch is stamped as tried when read, and the chats tried longest ago go first, so chats that keep failing can't hold
// back the ones after them. The steps for one chat, in an order any of them can fail and rerun from:
//   1. An Open chat closes, only while still past its cut-off, so no widget can bring its DO back.
//   2. The Conversation DO is wiped. A turn running leaves the chat for the next run.
//   3. An eval attempt's transcript objects go from R2, while their rows still name them.
//   4. One transaction clears every table and sets content_purged_at, which ends the job. It runs last so a failure
//      above leaves the chat due; a read model write can't follow, since the wipe waits for any sync and the DO is gone.
// eval_results is append-only, so a result keeps its transcript_file_id with no files row behind it: the Tests page's
// left join reads that as no transcript. Admin notes on quality issues stay (their own triage record, not chat text).
// A chat of an erased user (M6-2) takes the same steps whatever its age, and its notes go too: right after the erasure
// (purgeErasedUserContent), then in the hourly run for whatever that left, such as a chat with a turn running.
// One chat's failure is logged and skipped; the run carries on past it. No chat text reaches a log.
export default class ContentRetentionRepo {
  private env: Env;
  private db: NodePgDatabase;
  private changeRequestsDal: ChangeRequestsDAL;
  private companiesDal: CompaniesDAL;
  private conversationsDal: ConversationsDAL;
  private docGapsDal: DocGapsDAL;
  private feedbackDal: FeedbackDAL;
  private filesDal: FilesDAL;
  private messagesDal: MessagesDAL;
  private qualityIssuesDal: QualityIssuesDAL;
  private toolCallsDal: ToolCallsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.changeRequestsDal = new ChangeRequestsDAL();
    this.companiesDal = new CompaniesDAL();
    this.conversationsDal = new ConversationsDAL();
    this.docGapsDal = new DocGapsDAL();
    this.feedbackDal = new FeedbackDAL();
    this.filesDal = new FilesDAL();
    this.messagesDal = new MessagesDAL();
    this.qualityIssuesDal = new QualityIssuesDAL();
    this.toolCallsDal = new ToolCallsDAL();
  }

  // DEV_NOTE: companyIds as in getCompaniesRetention. batchSize and timeBudgetMs default to Constants (tests set them).
  // isSuccess false = a company's read failed; the other companies still ran.
  async purgeExpiredContent(
    params: {
      companyIds: string[] | null;
      now?: number;
      batchSize?: number;
      timeBudgetMs?: number;
    } = { companyIds: null },
  ): Promise<Schemas.PurgeConversationContentResponse> {
    const now = new Date(params.now ?? Date.now());
    const batchSize = params.batchSize ?? Constants.CONTENT_PURGE_BATCH_SIZE;
    const deadline = Date.now() + (params.timeBudgetMs ?? Constants.CONTENT_PURGE_TIME_BUDGET_MS);

    const listed: Schemas.CompaniesRetentionDALResponse = await withPlatform(
      this.db,
      async (tx) =>
        await this.companiesDal.getCompaniesRetention(tx, { companyIds: params.companyIds }),
    );
    if (!listed.isSuccess || !listed.companies) {
      return { isSuccess: false, message: listed.message, purgedCount: 0, skippedCount: 0 };
    }

    let purgedCount = 0;
    let skippedCount = 0;
    let hasFailedRead = false;
    // DEV_NOTE: Companies that may still have a chat due when the run ends: one with more than a batch, or a skip
    const unfinished = new Set<Schemas.CompanyRetentionRow>();
    let round = listed.companies;
    let isOutOfTime = false;

    while (round.length > 0 && !isOutOfTime) {
      const nextRound: Schemas.CompanyRetentionRow[] = [];
      for (const company of round) {
        if (Date.now() >= deadline && (purgedCount > 0 || skippedCount > 0)) {
          // DEV_NOTE: This round's companies not reached yet may have chats due too
          isOutOfTime = true;
          round.forEach((waiting) => unfinished.add(waiting));
          break;
        }
        const lastActivityBefore = this.retentionCutoff(company, now);
        const due = await this.claimDueConversations(company.id, {
          lastActivityBefore,
          now,
          batchSize,
        });
        if (!due.isSuccess || !due.conversations) {
          hasFailedRead = true;
          unfinished.delete(company);
          continue;
        }
        for (const row of due.conversations) {
          if (await this.purgeConversation(row, company, lastActivityBefore)) {
            purgedCount += 1;
          } else {
            skippedCount += 1;
            unfinished.add(company);
          }
        }
        if (due.conversations.length === batchSize) {
          nextRound.push(company);
          unfinished.add(company);
        }
      }
      round = nextRound;
    }

    const overdueCompanyCount = await this.alertOverdueCompanies([...unfinished], now);
    return {
      isSuccess: !hasFailedRead,
      message: hasFailedRead
        ? "A company's chats past retention could not be read"
        : "Conversation content purged",
      purgedCount,
      skippedCount,
      overdueCompanyCount,
    };
  }

  // DEV_NOTE: After an erasure's commit, so the admin isn't kept waiting and a failure can't undo it
  static purgeErasedUserInBackground(
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
    params: { companyId: string; chatbotUserId?: string },
  ): void {
    const { companyId, chatbotUserId } = params;
    if (!chatbotUserId) return;
    ctx.waitUntil(
      new ContentRetentionRepo(env).purgeErasedUserContent({ companyId, chatbotUserId }),
    );
  }

  // DEV_NOTE: One pass over the erased user's chats, inside what waitUntil allows. What it skips or doesn't reach is due
  // in the hourly run. Never throws.
  async purgeErasedUserContent(params: {
    companyId: string;
    chatbotUserId: string;
    timeBudgetMs?: number;
  }): Promise<Schemas.PurgeConversationContentResponse> {
    const { companyId, chatbotUserId } = params;
    const deadline =
      Date.now() + (params.timeBudgetMs ?? Constants.USER_ERASE_PURGE_TIME_BUDGET_MS);
    const read = await withTenant(this.db, companyId, async (tx) => {
      const company = await this.companiesDal.getCompanyDetails(tx, { companyId });
      if (!company.isSuccess || !company.company) throw new TenantRollbackError(company.message);
      const due = await this.conversationsDal.getUserConversationsToPurge(tx, {
        companyId,
        chatbotUserId,
        limit: Constants.CONTENT_PURGE_BATCH_SIZE,
      });
      if (!due.isSuccess || !due.conversations) throw new TenantRollbackError(due.message);
      return {
        isSuccess: true,
        message: due.message,
        company: company.company,
        conversations: due.conversations,
      };
    });
    if (!read.isSuccess || !("company" in read)) {
      return { isSuccess: false, message: read.message, purgedCount: 0, skippedCount: 0 };
    }

    let purgedCount = 0;
    let skippedCount = 0;
    for (const row of read.conversations) {
      if (Date.now() >= deadline) break;
      if (await this.purgeConversation(row, read.company, new Date())) {
        purgedCount += 1;
      } else {
        skippedCount += 1;
      }
    }
    return { isSuccess: true, message: "Erased user's content purged", purgedCount, skippedCount };
  }

  // DEV_NOTE: The one place a company's cut-off is worked out
  private retentionCutoff(company: Schemas.CompanyRetentionRow, now: Date): Date {
    const days = Schemas.effectiveContentRetentionDays(company.contentRetentionDays);
    return new Date(now.getTime() - days * Constants.DAY_MS);
  }

  // DEV_NOTE: One batch, stamped as tried in the read's own transaction
  private async claimDueConversations(
    companyId: string,
    params: { lastActivityBefore: Date; now: Date; batchSize: number },
  ): Promise<Schemas.ConversationsPastRetentionDALResponse> {
    return await withTenant(this.db, companyId, async (tx) => {
      const due = await this.conversationsDal.getConversationsPastRetention(tx, {
        companyId,
        lastActivityBefore: params.lastActivityBefore,
        now: params.now,
        limit: params.batchSize,
      });
      if (!due.isSuccess || !due.conversations) throw new TenantRollbackError(due.message);
      if (due.conversations.length > 0) {
        const marked = await this.conversationsDal.markConversationsPurgeAttempted(tx, {
          companyId,
          ids: due.conversations.map((row) => row.id),
          now: params.now,
        });
        if (!marked.isSuccess) throw new TenantRollbackError(marked.message);
      }
      return due;
    });
  }

  // DEV_NOTE: The alert that the purge isn't keeping its promise: stuck chats or a backlog. Company ids and ages only.
  private async alertOverdueCompanies(
    companies: Schemas.CompanyRetentionRow[],
    now: Date,
  ): Promise<number> {
    let overdueCompanyCount = 0;
    for (const company of companies) {
      const lastActivityBefore = this.retentionCutoff(company, now);
      const oldest: Schemas.OldestConversationPastRetentionDALResponse = await withTenant(
        this.db,
        company.id,
        async (tx) =>
          await this.conversationsDal.getOldestConversationPastRetention(tx, {
            companyId: company.id,
            lastActivityBefore,
          }),
      );
      const erased: Schemas.OldestErasedUserPendingDALResponse = await withTenant(
        this.db,
        company.id,
        async (tx) =>
          await this.conversationsDal.getOldestErasedUserPending(tx, { companyId: company.id }),
      );
      // DEV_NOTE: Past the cut-off, or since the erasure (M6-2), whichever has waited longer
      const overdueMs = Math.max(
        oldest.lastActivityAt ? lastActivityBefore.getTime() - oldest.lastActivityAt.getTime() : 0,
        erased.erasedAt ? now.getTime() - erased.erasedAt.getTime() : 0,
      );
      if (overdueMs < Constants.CONTENT_PURGE_OVERDUE_ALERT_MS) continue;
      overdueCompanyCount += 1;
      AppLogger.error({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.PurgeConversationContent,
        message: "Chat content is overdue for deletion",
        metadata: { companyId: company.id, overdueHours: Math.floor(overdueMs / 3_600_000) },
      });
    }
    return overdueCompanyCount;
  }

  // DEV_NOTE: true = cleared; false = left due for the next run (each step logs why)
  private async purgeConversation(
    row: Schemas.ConversationPastRetentionRow,
    company: Schemas.CompanyRetentionRow,
    lastActivityBefore: Date,
  ): Promise<boolean> {
    const { companyId, publicId } = row;

    if (row.status === Schemas.ConversationStatusIntEnum.Open) {
      // DEV_NOTE: An erased user's chat closes whatever its last activity, so the cut-off is past any chat
      const closeBefore = row.erasedAt
        ? new Date(Date.now() + Constants.DAY_MS)
        : lastActivityBefore;
      const closed = await this.closeConversation(row, closeBefore);
      if (!closed.isSuccess) return false;
    }

    if (!(await this.wipeConversationDo(row))) return false;

    const transcripts = await this.deleteTranscriptObjects(row, company);
    if (!transcripts.isSuccess || !transcripts.files) return false;
    const fileIds = transcripts.files.map((file) => file.id);

    const cleared = await withTenant(this.db, companyId, async (tx) => {
      const request = { companyId, conversationId: row.id };
      const steps = [
        await this.messagesDal.clearConversationContent(tx, request),
        await this.feedbackDal.clearConversationComments(tx, request),
        await this.toolCallsDal.clearConversationArgs(tx, request),
        await this.changeRequestsDal.clearConversationValues(tx, request),
        await this.docGapsDal.clearConversationRefs(tx, request),
        await this.filesDal.deleteFiles(tx, { companyId, ids: fileIds }),
        ...(row.erasedAt
          ? [
              await this.qualityIssuesDal.clearChatbotUserNotes(tx, {
                companyId,
                chatbotUserId: row.chatbotUserId,
              }),
            ]
          : []),
        await this.conversationsDal.markConversationContentPurged(tx, { companyId, publicId }),
      ];
      const failed = steps.find((step) => !step.isSuccess);
      if (failed) throw new TenantRollbackError(failed.message ?? "Content purge step failed");
      return { isSuccess: true, message: "Conversation content cleared" };
    });
    return cleared.isSuccess;
  }

  // DEV_NOTE: The outcome the DO's own close would pick, from the read model, since the DO may be long gone: a reply =
  // Answered, or Idk with a doc gap on the last question; else Abandoned.
  private async closeConversation(
    row: Schemas.ConversationPastRetentionRow,
    lastActivityBefore: Date,
  ): Promise<Schemas.ApiResponse> {
    const { companyId, publicId } = row;
    const conversationId = row.id;
    return await withTenant(this.db, companyId, async (tx) => {
      const reply = await this.messagesDal.hasAssistantReply(tx, { companyId, conversationId });
      if (!reply.isSuccess) return { isSuccess: false, message: reply.message };
      let outcome = reply.hasReply
        ? Schemas.ConversationOutcomeIntEnum.Answered
        : Schemas.ConversationOutcomeIntEnum.Abandoned;
      if (reply.hasReply) {
        const gap = await this.docGapsDal.hasDocGapOnLastUserMessage(tx, {
          companyId,
          conversationId,
        });
        if (!gap.isSuccess) return { isSuccess: false, message: gap.message };
        if (gap.hasDocGap) outcome = Schemas.ConversationOutcomeIntEnum.Idk;
      }
      const { conversation: _conversation, ...result } =
        await this.conversationsDal.closeConversationPastRetention(tx, {
          companyId,
          publicId,
          lastActivityBefore,
          outcome,
        });
      return result;
    });
  }

  private async wipeConversationDo(row: Schemas.ConversationPastRetentionRow): Promise<boolean> {
    const metadata = { companyId: row.companyId, conversationPublicId: row.publicId };
    try {
      const stub = await getAgentByName(this.env.CONVERSATION_DO, row.publicId);
      const wiped = Schemas.ZConversationContentWipeResponse.safeParse(
        Utility.parseJson(await stub.purgeContent()),
      );
      if (wiped.success && wiped.data.isSuccess) return true;
      AppLogger.warn({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.PurgeConversationContent,
        message: wiped.success ? wiped.data.message : "Conversation DO answered something else",
        metadata,
      });
    } catch (error) {
      // DEV_NOTE: Also how destroy()'s abort can look from here; the next run finds nothing left and goes on
      AppLogger.warn({
        category: Schemas.LogCategory.Conversation,
        action: Schemas.LogAction.PurgeConversationContent,
        message: "Conversation DO not wiped this run",
        metadata: { ...metadata, errorName: error instanceof Error ? error.name : "Unknown" },
      });
    }
    return false;
  }

  // DEV_NOTE: The attempt's transcript rows, their objects deleted (a missing object is no error, so a rerun is safe).
  // A widget chat has none.
  private async deleteTranscriptObjects(
    row: Schemas.ConversationPastRetentionRow,
    company: Schemas.CompanyRetentionRow,
  ): Promise<Schemas.FilesDALResponse> {
    const { companyId, evalRunId, evalCaseId, evalAttempt } = row;
    if (evalRunId === null || evalCaseId === null || evalAttempt === null) {
      return { isSuccess: true, files: [] };
    }
    const found: Schemas.FilesDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx) =>
        await this.filesDal.getEvalAttemptTranscriptFiles(tx, {
          companyId,
          evalRunId,
          evalCaseId,
          attempt: evalAttempt,
        }),
    );
    if (!found.isSuccess || !found.files || found.files.length === 0) return found;

    const deleted = await FileStorageProvider.deleteObjects(this.env, {
      keys: found.files.map((file) => Schemas.fileR2Key(company.publicId, file.publicId)),
    });
    return deleted.isSuccess ? found : { isSuccess: false, message: deleted.message };
  }
}

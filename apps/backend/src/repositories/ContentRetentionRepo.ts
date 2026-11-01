import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getAgentByName } from "agents";
import Constants from "@/config/Constants";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import DocGapsDAL from "@/data-access-layer/DocGapsDAL";
import FeedbackDAL from "@/data-access-layer/FeedbackDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import ToolCallsDAL from "@/data-access-layer/ToolCallsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import FileStorageProvider from "@/providers/fileStorage";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

const DAY_MS = 24 * 60 * 60 * 1000;

// DEV_NOTE: The retention purge (M6-1): a chat past last_activity_at + its company's days keeps only counts, statuses,
// costs and doc gap text. The chats due are read across companies (withPlatform, pattern rule 3.15); each chat's writes
// are its company's (withTenant). The steps, in an order any of them can fail and rerun from:
//   1. An Open chat closes, only while still past its cut-off, so no widget can bring its DO back.
//   2. The Conversation DO is wiped. A turn running leaves the chat for the next run.
//   3. An eval attempt's transcript objects go from R2, while their rows still name them.
//   4. One transaction clears every table and sets content_purged_at, which ends the job. It runs last so a failure
//      above leaves the chat due; a read model write can't follow, since the DO that writes it is gone.
// eval_results is append-only, so a result keeps its transcript_file_id with no files row behind it: the Tests page's
// left join reads that as no transcript. Admin notes on quality issues stay (their own triage record, not chat text).
// One chat's failure is logged and skipped; the run carries on past it. No chat text reaches a log.
export default class ContentRetentionRepo {
  private env: Env;
  private db: NodePgDatabase;
  private changeRequestsDal: ChangeRequestsDAL;
  private conversationsDal: ConversationsDAL;
  private docGapsDal: DocGapsDAL;
  private feedbackDal: FeedbackDAL;
  private filesDal: FilesDAL;
  private messagesDal: MessagesDAL;
  private toolCallsDal: ToolCallsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.changeRequestsDal = new ChangeRequestsDAL();
    this.conversationsDal = new ConversationsDAL();
    this.docGapsDal = new DocGapsDAL();
    this.feedbackDal = new FeedbackDAL();
    this.filesDal = new FilesDAL();
    this.messagesDal = new MessagesDAL();
    this.toolCallsDal = new ToolCallsDAL();
  }

  async purgeExpiredContent(
    params: { companyIds: string[] | null; now?: number } = { companyIds: null },
  ): Promise<Schemas.PurgeConversationContentResponse> {
    const now = new Date(params.now ?? Date.now());
    let afterId: string | null = null;
    let purgedCount = 0;
    let skippedCount = 0;

    for (let batch = 0; batch < Constants.CONTENT_PURGE_MAX_BATCHES; batch += 1) {
      const lastId: string | null = afterId;
      const due: Schemas.ConversationsPastRetentionDALResponse = await withPlatform(
        this.db,
        async (tx) =>
          await this.conversationsDal.getConversationsPastRetention(tx, {
            companyIds: params.companyIds,
            now,
            afterId: lastId,
            limit: Constants.CONTENT_PURGE_BATCH_SIZE,
          }),
      );
      if (!due.isSuccess || !due.conversations) {
        return { isSuccess: false, message: due.message, purgedCount, skippedCount };
      }

      for (const row of due.conversations) {
        afterId = row.id;
        if (await this.purgeConversation(row, now)) {
          purgedCount += 1;
        } else {
          skippedCount += 1;
        }
      }
      if (due.conversations.length < Constants.CONTENT_PURGE_BATCH_SIZE) break;
    }

    return { isSuccess: true, message: "Conversation content purged", purgedCount, skippedCount };
  }

  // DEV_NOTE: true = cleared; false = left due for the next run (each step logs why)
  private async purgeConversation(
    row: Schemas.ConversationPastRetentionRow,
    now: Date,
  ): Promise<boolean> {
    const { companyId, publicId } = row;

    if (row.status === Schemas.ConversationStatusIntEnum.Open) {
      const days = Schemas.effectiveContentRetentionDays(row.contentRetentionDays);
      const closed = await withTenant(
        this.db,
        companyId,
        async (tx) =>
          await this.conversationsDal.closeConversationPastRetention(tx, {
            companyId,
            publicId,
            lastActivityBefore: new Date(now.getTime() - days * DAY_MS),
          }),
      );
      if (!closed.isSuccess) return false;
    }

    if (!(await this.wipeConversationDo(row))) return false;

    const transcripts = await this.deleteTranscriptObjects(row);
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
        await this.conversationsDal.markConversationContentPurged(tx, { companyId, publicId }),
      ];
      const failed = steps.find((step) => !step.isSuccess);
      if (failed) throw new TenantRollbackError(failed.message ?? "Content purge step failed");
      return { isSuccess: true, message: "Conversation content cleared" };
    });
    return cleared.isSuccess;
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
      // DEV_NOTE: Also how destroy()'s abort can look from here; the next run finds no state and goes on
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
      keys: found.files.map((file) => Schemas.fileR2Key(row.companyPublicId, file.publicId)),
    });
    return deleted.isSuccess ? found : { isSuccess: false, message: deleted.message };
  }
}

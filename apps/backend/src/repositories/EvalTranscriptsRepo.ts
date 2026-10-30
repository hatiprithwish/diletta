import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getAgentByName } from "agents";
import Constants from "@/config/Constants";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import EvalTranscriptProvider from "@/providers/evalTranscript";
import EvalTranscriptFilesProvider from "@/providers/evalTranscriptFiles";
import FileStorageProvider from "@/providers/fileStorage";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: An eval attempt's transcript (M5-3), for EvalHarnessRepo's judge and recordResult steps:
//   read: the attempt as its Conversation DO holds it (getEvalTranscript over DO RPC: the DO answers once idle, and an
//     idle eval conversation never changes, so the judge and the stored file read the same attempt) and its change
//     requests' summaries (no values). The DO unreachable or still busy, or an answer that won't parse, is a
//     ServerError.
//   store: transcript v1 (EvalTranscriptProvider.build) as a files row pending its owner (its own withTenant), then the
//     R2 object. The result's transaction attaches the row (EvalTranscriptFilesProvider.attach).
//   discard: a stored transcript whose result is known not to be written: the row (only while still pending), then its
//     object.
//   sweepPending: hourly (EvalTranscriptSweep cron), every company (withPlatform): transcript rows still pending after
//     EVAL_TRANSCRIPT_PENDING_MAX_AGE_MS, with their objects.
// Both remove rows first, through a delete that re-checks they are still pending, then only the objects of the rows it
// removed: a row a result attached meanwhile (a /results that ran past the sweep's age) keeps its object. An object
// whose delete fails after its row is gone is logged with its key (FileStorageProvider) for cleanup.
// Transcript text, values and host data stay out of every log.
export default class EvalTranscriptsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private changeRequestsDal: ChangeRequestsDAL;
  private filesDal: FilesDAL;

  // DEV_NOTE: db = the caller's client when it has one (one pool per request), else its own
  constructor(env: Env, db: NodePgDatabase = getDbClient(env)) {
    this.env = env;
    this.db = db;
    this.changeRequestsDal = new ChangeRequestsDAL();
    this.filesDal = new FilesDAL();
  }

  async read(params: {
    companyId: string;
    source: Schemas.EvalRunTranscriptSource;
  }): Promise<Schemas.EvalAttemptRecordResponse> {
    const { companyId, source } = params;
    const metadata = { companyId, conversationPublicId: source.conversationPublicId };
    let read: Schemas.EvalAttemptTranscriptResponse;
    try {
      const stub = await getAgentByName(this.env.CONVERSATION_DO, source.conversationPublicId);
      const parsed = Schemas.ZEvalAttemptTranscriptResponse.safeParse(
        Utility.parseJson(await stub.getEvalTranscript()),
      );
      read = parsed.success
        ? parsed.data
        : { isSuccess: false, message: "Conversation DO answered something else" };
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Eval,
        action: Schemas.LogAction.GetEvalTranscript,
        message: "Conversation DO unreachable",
        error,
        metadata,
      });
      read = { isSuccess: false, message: "Conversation DO unreachable" };
    }
    if (!read.isSuccess || !read.entries) {
      return this.serverError(Schemas.LogAction.GetEvalTranscript, read.message, metadata);
    }
    const entries = read.entries;

    const changeRequestIds = [
      ...new Set(
        entries.flatMap((entry) =>
          entry.kind === Schemas.EvalAttemptEntryKindEnum.ToolCall && entry.changeRequestId !== null
            ? [entry.changeRequestId]
            : [],
        ),
      ),
    ];
    // DEV_NOTE: No change request (a chat, or reads only): nothing to look up, no transaction
    const listed: Schemas.ChangeRequestsDALResponse =
      changeRequestIds.length === 0
        ? { isSuccess: true, changeRequests: [] }
        : await withTenant(
            this.db,
            companyId,
            async (tx) =>
              await this.changeRequestsDal.listConversationChangeRequests(tx, {
                companyId,
                conversationId: source.conversationId,
                publicIds: changeRequestIds,
              }),
          );
    if (!listed.isSuccess) {
      return this.serverError(Schemas.LogAction.GetEvalTranscript, listed.message, metadata);
    }

    return {
      isSuccess: true,
      message: "Eval attempt read",
      record: {
        entries,
        changeRequestSummaries: Object.fromEntries(
          (listed.changeRequests ?? []).map((row) => [row.publicId, row.summary]),
        ),
      },
    };
  }

  async store(params: {
    companyId: string;
    source: Schemas.EvalRunTranscriptSource;
    record: Schemas.EvalAttemptRecord;
  }): Promise<Schemas.StoredEvalTranscriptResponse> {
    const { companyId, source } = params;
    const metadata = { companyId, conversationPublicId: source.conversationPublicId };
    const result = EvalTranscriptProvider.build({
      record: params.record,
      toolVersions: source.toolVersions,
    });
    if (!result.isSuccess) {
      return this.serverError(
        Schemas.LogAction.StoreEvalTranscript,
        result.failure === Schemas.EvalTranscriptBuildFailureEnum.TooLarge
          ? "The transcript is over its size cap at every cut"
          : "The transcript doesn't hold to its schema",
        { ...metadata, failure: result.failure },
      );
    }
    const { built } = result;

    const file = {
      publicId: Utility.generatePublicId(),
      sizeBytes: built.bytes.byteLength,
      sha256: await Utility.sha256Hex(built.text),
    };
    const created: Schemas.FileDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx) => await EvalTranscriptFilesProvider.createPending(tx, { companyId, file }),
    );
    if (!created.isSuccess || !created.file) {
      return this.serverError(Schemas.LogAction.StoreEvalTranscript, created.message, metadata);
    }
    const stored = {
      fileId: created.file.id,
      fileR2Key: Schemas.fileR2Key(source.companyPublicId, file.publicId),
    };

    const put = await FileStorageProvider.putObject(this.env, {
      key: stored.fileR2Key,
      bytes: built.bytes,
      mime: Schemas.EVAL_TRANSCRIPT_MIME,
    });
    if (!put.isSuccess) {
      await this.discard({ companyId, stored });
      return this.serverError(
        Schemas.LogAction.StoreEvalTranscript,
        "The transcript couldn't be stored",
        metadata,
      );
    }
    return { isSuccess: true, message: "Eval transcript stored", stored };
  }

  async discard(params: {
    companyId: string;
    stored: { fileId: string; fileR2Key: string };
  }): Promise<Schemas.ApiResponse> {
    const { companyId, stored } = params;
    const removed: Schemas.FilesDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx) =>
        await EvalTranscriptFilesProvider.remove(tx, { companyId, fileIds: [stored.fileId] }),
    );
    if (!removed.isSuccess) return removed;
    if ((removed.files ?? []).length === 0) {
      return { isSuccess: true, message: "The transcript is no longer pending: kept" };
    }
    return await FileStorageProvider.deleteObjects(this.env, { keys: [stored.fileR2Key] });
  }

  async sweepPending(params: { now?: number } = {}): Promise<Schemas.SweepEvalTranscriptsResponse> {
    const createdBefore = new Date(
      (params.now ?? Date.now()) - Constants.EVAL_TRANSCRIPT_PENDING_MAX_AGE_MS,
    );
    let sweptCount = 0;

    for (let batch = 0; batch < Constants.EVAL_TRANSCRIPT_SWEEP_MAX_BATCHES; batch += 1) {
      const pending: Schemas.PendingOwnerFilesDALResponse = await withPlatform(
        this.db,
        async (tx) =>
          await this.filesDal.getPendingOwnerFiles(tx, {
            ownerType: Schemas.FileOwnerTypeEnum.EvalResult,
            createdBefore,
            limit: Constants.EVAL_TRANSCRIPT_SWEEP_BATCH_SIZE,
          }),
      );
      if (!pending.isSuccess || !pending.files) {
        return { isSuccess: false, message: pending.message, sweptCount };
      }
      const rows = pending.files;
      if (rows.length === 0) break;

      const byCompany = new Map<string, Schemas.PendingOwnerFileRow[]>();
      for (const row of rows) {
        const companyRows = byCompany.get(row.companyId);
        if (companyRows) {
          companyRows.push(row);
        } else {
          byCompany.set(row.companyId, [row]);
        }
      }
      const removed: Schemas.SweptEvalTranscriptsResponse = await withPlatform(
        this.db,
        async (tx) => {
          const keys: string[] = [];
          for (const [companyId, companyRows] of byCompany) {
            const result = await EvalTranscriptFilesProvider.remove(tx, {
              companyId,
              fileIds: companyRows.map((row) => row.id),
            });
            if (!result.isSuccess) return result;
            const removedIds = new Set((result.files ?? []).map((file) => file.id));
            for (const row of companyRows) {
              if (removedIds.has(row.id)) {
                keys.push(Schemas.fileR2Key(row.companyPublicId, row.publicId));
              }
            }
          }
          return { isSuccess: true, message: "Pending transcripts removed", keys };
        },
      );
      if (!removed.isSuccess) return { isSuccess: false, message: removed.message, sweptCount };
      const keys = "keys" in removed ? (removed.keys ?? []) : [];
      const deleted = await FileStorageProvider.deleteObjects(this.env, { keys });
      if (!deleted.isSuccess) return { isSuccess: false, message: deleted.message, sweptCount };
      sweptCount += keys.length;
      if (rows.length < Constants.EVAL_TRANSCRIPT_SWEEP_BATCH_SIZE) break;
    }

    return { isSuccess: true, message: "Pending eval transcripts swept", sweptCount };
  }

  private serverError(
    action: Schemas.LogAction,
    message: string | undefined,
    metadata: Record<string, unknown>,
  ): { isSuccess: false; message: string; failure: Schemas.EvalRunStepFailureEnum } {
    const text = message ?? "The transcript couldn't be read";
    AppLogger.error({
      category: Schemas.LogCategory.Eval,
      action,
      message: text,
      metadata,
    });
    return { isSuccess: false, message: text, failure: Schemas.EvalRunStepFailureEnum.ServerError };
  }
}

import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeDocumentsDAL from "@/data-access-layer/KnowledgeDocumentsDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import FileStorageProvider from "@/providers/fileStorage";
import KnowledgeChunkerProvider from "@/providers/knowledgeChunker";
import KnowledgeDocumentFilesProvider from "@/providers/knowledgeDocumentFiles";
import KnowledgeEmbedProvider from "@/providers/knowledgeEmbed";
import KnowledgeEmbedCallsProvider from "@/providers/knowledgeEmbedCalls";
import KnowledgeExtractProvider from "@/providers/knowledgeExtract";
import KnowledgeFetchProvider from "@/providers/knowledgeFetch";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The steps of one source sync (M2-5), each called from its own KnowledgeSyncWorkflow step, each opening its
// own withTenant transactions (companyId: the internal id from the workflow params, set server-side at the claim).
//
// Ownership: the claim stored the run's syncRunId on the source. Every write first locks the source row FOR UPDATE and
// requires it to be Syncing and owned by this run (a pause, a delete and a newer claim take the same lock), so a run
// left behind writes nothing and stops (outcome Stopped); every write also refreshes the run's heartbeat.
//
// Per item: fetch (web, same site only) or read from R2 (upload) → convert to markdown → normalize → content_hash
// (pipeline version + sha256 of the text). A document whose stored hash matches and that is Indexed is Unchanged:
// nothing is chunked and no embed call is made. Otherwise it is chunked and embedded (one model_calls row per Workers
// AI call), a new page's bytes go to R2 under a new file, then one transaction stores the file, the document
// (re-read under the lock) and its chunks (old deleted, new written).
//
// A database or storage failure answers isSuccess false, and the workflow step throws so Workflows retries it; an
// expected failure (dead page, unsupported type, embedding refused) is an outcome and the sync goes on.
export default class KnowledgeIngestionRepo {
  private env: Env;
  private db: NodePgDatabase;
  private sourcesDal: KnowledgeSourcesDAL;
  private documentsDal: KnowledgeDocumentsDAL;
  private chunksDal: KnowledgeChunksDAL;
  private filesDal: FilesDAL;
  private companiesDal: CompaniesDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.sourcesDal = new KnowledgeSourcesDAL();
    this.documentsDal = new KnowledgeDocumentsDAL();
    this.chunksDal = new KnowledgeChunksDAL();
    this.filesDal = new FilesDAL();
    this.companiesDal = new CompaniesDAL();
  }

  // DEV_NOTE: Round 0 lists the whole source: a sitemap's pages, a url source's one page, or an upload source's
  // documents with work to do (Pending, Failed, or indexed by an older pipeline). Later rounds (upload sources only)
  // list the documents still Pending: files uploaded while the sync ran.
  async listSyncItems(
    params: Schemas.KnowledgeSyncWorkflowParams & { round: number },
  ): Promise<Schemas.ListKnowledgeSyncItemsResponse> {
    const owned = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.SyncingKnowledgeSourceResponse> => {
        return await this.lockOwnedSource(tx, params);
      },
    );
    if (!owned.isSuccess) return { isSuccess: false, message: owned.message };
    const source = "source" in owned ? owned.source : undefined;
    if (!source) {
      return { isSuccess: true, message: "Knowledge source is not syncing", isStopped: true };
    }

    if (source.type === Schemas.KnowledgeSourceTypeIntEnum.Upload) {
      const documents = await withTenant(this.db, params.companyId, async (tx) => {
        const scope = { companyId: params.companyId, knowledgeSourceId: source.id };
        return params.round === 0
          ? await this.documentsDal.getKnowledgeDocumentsToIndex(tx, {
              ...scope,
              contentHashPrefix: `${Schemas.KNOWLEDGE_PIPELINE_VERSION}:`,
              limit: Constants.KNOWLEDGE_MAX_ITEMS_PER_SYNC,
            })
          : await this.documentsDal.getKnowledgeDocumentsBySource(tx, {
              ...scope,
              indexStatuses: [Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending],
              limit: Constants.KNOWLEDGE_MAX_ITEMS_PER_SYNC,
            });
      });
      if (!documents.isSuccess || !("knowledgeDocuments" in documents)) {
        return { isSuccess: false, message: documents.message };
      }
      return {
        isSuccess: true,
        message: "Knowledge sync items listed successfully",
        items: (documents.knowledgeDocuments ?? []).map((document) => ({
          knowledgeDocumentPublicId: document.publicId,
        })),
        isWebSource: false,
        isComplete: false,
      };
    }

    // DEV_NOTE: Web sources are listed once (round 0): the listing is the whole site
    const site = source.url ? KnowledgeFetchProvider.siteOf(source.url) : null;
    if (params.round > 0) {
      return {
        isSuccess: true,
        message: "Nothing more to list",
        items: [],
        isWebSource: true,
        isComplete: false,
      };
    }
    if (!source.url || !site) {
      return {
        isSuccess: true,
        message: "Knowledge source URL is not crawlable",
        isListingFailed: true,
      };
    }
    if (source.type === Schemas.KnowledgeSourceTypeIntEnum.Url) {
      return {
        isSuccess: true,
        message: "Knowledge sync items listed successfully",
        items: [{ url: KnowledgeFetchProvider.normalizeUrl(source.url, site) ?? source.url }],
        isWebSource: true,
        isComplete: true,
      };
    }

    const listed = await KnowledgeFetchProvider.listSitemapUrls(source.url);
    if (!listed.isSuccess || !listed.urls) {
      AppLogger.warn({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.ListKnowledgeSyncItems,
        message: "Sitemap could not be listed",
        metadata: { ...params, reason: listed.message ?? null },
      });
      return { isSuccess: true, message: listed.message, isListingFailed: true };
    }
    return {
      isSuccess: true,
      message: "Knowledge sync items listed successfully",
      items: listed.urls.map((url) => ({ url })),
      isWebSource: true,
      isComplete: listed.isComplete ?? false,
    };
  }

  async ingestSyncItem(
    params: Schemas.KnowledgeSyncItemParams,
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    const context = await this.loadItemContext(params);
    if (!context.isSuccess) {
      return { isSuccess: false, message: context.message };
    }
    if (!context.source || !context.companyPublicId) {
      return this.stopped();
    }
    const { source, companyPublicId } = context;
    const existing = context.existing ?? null;
    const isUpload = "knowledgeDocumentPublicId" in params.item;
    if (isUpload && !existing) {
      return {
        isSuccess: true,
        message: "Knowledge document is gone",
        outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Failed,
      };
    }

    const content = await this.loadContent(params, source, companyPublicId, existing);
    if (!content.isSuccess || !content.bytes || !content.mime) {
      // DEV_NOTE: An upload's stored file that can't be read (database, R2) is retried; a missing one, like a dead or
      // unsupported web page, fails the item
      if (isUpload && !content.isNotFound) {
        return { isSuccess: false, message: content.message };
      }
      return await this.markFailed(params, content.message ?? "Document could not be read");
    }

    const extracted = await KnowledgeExtractProvider.toText(this.env, {
      bytes: content.bytes,
      mime: content.mime,
      charset: content.charset ?? null,
    });
    const text = KnowledgeChunkerProvider.normalizeText(extracted.text ?? "");
    if (!extracted.isSuccess || !text) {
      return await this.markFailed(params, extracted.message ?? "Document has no text");
    }

    // DEV_NOTE: The content_hash skip: an unchanged, already indexed document is never chunked or embedded again
    const contentHash = await KnowledgeChunkerProvider.contentHash(text);
    if (
      existing &&
      existing.contentHash === contentHash &&
      existing.indexStatus === Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed
    ) {
      return await this.markUnchanged(params);
    }

    const chunked = KnowledgeChunkerProvider.chunk(text);
    if (chunked.isTruncated) {
      AppLogger.warn({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.IngestKnowledgeSyncItem,
        message: "Knowledge document has more chunks than the cap; only the first ones are kept",
        metadata: { ...params, kept: chunked.chunks.length },
      });
    }

    const embedded = await this.embedChunks(params.companyId, companyPublicId, chunked.chunks);
    if (!embedded.isSuccess || !embedded.chunks) {
      const failed = await this.markFailed(params, embedded.message ?? "Embedding failed");
      return { ...failed, embedCallCount: embedded.callCount };
    }

    const title =
      KnowledgeChunkerProvider.extractTitle(text) ??
      ("url" in params.item
        ? KnowledgeFetchProvider.titleFromUrl(params.item.url)
        : (existing?.title ?? null));
    const stored = await this.storeDocument(params, {
      companyPublicId,
      content: { bytes: content.bytes, mime: content.mime },
      title,
      contentHash,
      chunks: embedded.chunks,
    });
    return { ...stored, embedCallCount: embedded.callCount };
  }

  // DEV_NOTE: A web source's documents whose URL the finished, complete listing no longer has (removed from the
  // sitemap) are deleted with their chunks, files and R2 objects. The workflow never calls it for a partial listing,
  // and an empty listing prunes nothing: a site serving an empty sitemap for a moment must not wipe its knowledge.
  async pruneUnlistedDocuments(
    params: Schemas.KnowledgeSyncWorkflowParams & { listedUrls: string[] },
  ): Promise<Schemas.PruneKnowledgeDocumentsResponse> {
    if (params.listedUrls.length === 0) {
      AppLogger.warn({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.PruneKnowledgeDocuments,
        message: "Listing is empty; nothing pruned",
        metadata: {
          companyId: params.companyId,
          knowledgeSourcePublicId: params.knowledgeSourcePublicId,
        },
      });
      return { isSuccess: true, message: "Listing is empty; nothing pruned", deletedCount: 0 };
    }

    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.RemoveKnowledgeDocumentsResponse> => {
        const owned = await this.lockOwnedSource(tx, params);
        if (!owned.isSuccess) throw new TenantRollbackError(owned.message);
        if (!owned.source || !owned.companyPublicId) {
          return { isSuccess: true, message: "Knowledge source is not syncing", deletedCount: 0 };
        }

        const unlisted = await this.documentsDal.getUnlistedKnowledgeDocuments(tx, {
          companyId: params.companyId,
          knowledgeSourceId: owned.source.id,
          listedSourceUrls: params.listedUrls,
        });
        if (!unlisted.isSuccess || !unlisted.knowledgeDocuments) {
          throw new TenantRollbackError(unlisted.message);
        }

        const removed = await KnowledgeDocumentFilesProvider.remove(tx, {
          companyId: params.companyId,
          companyPublicId: owned.companyPublicId,
          documents: unlisted.knowledgeDocuments,
        });
        if (!removed.isSuccess) throw new TenantRollbackError(removed.message);
        return removed;
      },
    );

    if (!result.isSuccess) return { isSuccess: false, message: result.message };
    const fileR2Keys = "fileR2Keys" in result ? (result.fileR2Keys ?? []) : [];
    if (fileR2Keys.length > 0) {
      await FileStorageProvider.deleteObjects(this.env, { keys: fileR2Keys });
    }
    return {
      isSuccess: true,
      message: "Unlisted knowledge documents pruned",
      deletedCount: "deletedCount" in result ? (result.deletedCount ?? 0) : 0,
    };
  }

  // DEV_NOTE: Ends the sync: Active with last_synced_at = now, or Failed (the listing failed, or every item failed).
  // Only while this run owns the source: a paused, deleted or re-claimed one stays as it is. hasPendingDocuments tells
  // the workflow an upload source got files after its last listing, so it starts another sync.
  async finishSync(
    params: Schemas.KnowledgeSyncWorkflowParams & { isFailed: boolean },
  ): Promise<Schemas.FinishKnowledgeSyncResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.FinishKnowledgeSyncResponse> => {
        const owned = await this.lockOwnedSource(tx, params);
        if (!owned.isSuccess) return { isSuccess: false, message: owned.message };
        if (!owned.source) return { isSuccess: true, message: "Knowledge source is not syncing" };

        const finished = await this.sourcesDal.setKnowledgeSourceSyncState(tx, {
          companyId: params.companyId,
          publicId: params.knowledgeSourcePublicId,
          status: params.isFailed
            ? Schemas.KnowledgeSourceStatusIntEnum.Failed
            : Schemas.KnowledgeSourceStatusIntEnum.Active,
          lastSyncedAt: params.isFailed ? null : new Date(),
          syncRunId: null,
        });
        if (!finished.isSuccess) throw new TenantRollbackError(finished.message);

        if (owned.source.type !== Schemas.KnowledgeSourceTypeIntEnum.Upload) {
          return { isSuccess: true, message: "Knowledge sync finished" };
        }
        const pending = await this.documentsDal.getKnowledgeDocumentsBySource(tx, {
          companyId: params.companyId,
          knowledgeSourceId: owned.source.id,
          indexStatuses: [Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending],
          limit: 1,
        });
        if (!pending.isSuccess || !pending.knowledgeDocuments) {
          throw new TenantRollbackError(pending.message);
        }
        return {
          isSuccess: true,
          message: "Knowledge sync finished",
          hasPendingDocuments: pending.knowledgeDocuments.length > 0,
        };
      },
    );
  }

  // DEV_NOTE: The source (only while this run owns it), the company's public id (R2 keys, gateway metadata) and the
  // document the item already has, if any. Read without a lock: the store re-reads the document under it.
  private async loadItemContext(
    params: Schemas.KnowledgeSyncItemParams,
  ): Promise<Schemas.KnowledgeSyncItemContextResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.KnowledgeSyncItemContextResponse> => {
        const owned = await this.findOwnedSource(tx, params, false);
        if (!owned.isSuccess || !owned.source) return owned;
        const existing = await this.findItemDocument(tx, params, owned.source.id);
        if (!existing.isSuccess && !existing.isNotFound) {
          return { isSuccess: false, message: existing.message };
        }
        return { ...owned, existing: existing.knowledgeDocument ?? null };
      },
    );
  }

  // DEV_NOTE: The item's bytes: fetched for a web page (same site only, capped, supported types only), read back from
  // R2 for an upload (isNotFound when its file row or object is gone)
  private async loadContent(
    params: Schemas.KnowledgeSyncItemParams,
    source: Schemas.KnowledgeSource,
    companyPublicId: string,
    existing: Schemas.KnowledgeDocument | null,
  ): Promise<Schemas.KnowledgeFetchResponse> {
    if ("url" in params.item) {
      const site = source.url ? KnowledgeFetchProvider.siteOf(source.url) : null;
      if (!site) return { isSuccess: false, message: "Knowledge source URL is not crawlable" };
      const fetched = await KnowledgeFetchProvider.fetchDocument(params.item.url, {
        site,
        maxBytes: Constants.KNOWLEDGE_PAGE_MAX_BYTES,
      });
      if (fetched.isSuccess && !KnowledgeExtractProvider.isSupportedMime(fetched.mime ?? "")) {
        return {
          isSuccess: false,
          message: `Unsupported document type: ${fetched.mime || "none"}`,
        };
      }
      return fetched;
    }
    if (!existing) {
      return { isSuccess: false, isNotFound: true, message: "Knowledge document not found" };
    }

    const file = await withTenant(this.db, params.companyId, async (tx) => {
      return await this.filesDal.getFile(tx, { id: existing.fileId, companyId: params.companyId });
    });
    if (!file.isSuccess || !("file" in file) || !file.file) {
      return { isSuccess: false, isNotFound: file.isNotFound, message: file.message };
    }
    const object = await FileStorageProvider.getObject(this.env, {
      key: Schemas.fileR2Key(companyPublicId, file.file.publicId),
    });
    if (!object.isSuccess || !object.bytes) {
      return { isSuccess: false, isNotFound: object.isNotFound, message: object.message };
    }
    return { isSuccess: true, bytes: object.bytes, mime: file.file.mime, charset: null };
  }

  // DEV_NOTE: Embeds every chunk (heading path + text) and writes one model_calls row per Workers AI call made, even
  // when a call failed. The price is checked first, so a model missing from PLATFORM_MODEL_PRICES is refused before
  // any call. A failed row write rolls the batch back and is logged as an error with the calls' token counts (the
  // spend stays visible); the document itself goes on.
  private async embedChunks(
    companyId: string,
    companyPublicId: string,
    chunks: Schemas.KnowledgeChunkDraft[],
  ): Promise<Schemas.EmbedKnowledgeChunksResponse> {
    if (chunks.length === 0) {
      return { isSuccess: true, chunks: [], callCount: 0 };
    }
    const price = KnowledgeEmbedCallsProvider.price();
    if (!price) {
      const message = "Embedding model is not priced";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.EmbedKnowledgeChunks,
        message,
        metadata: { model: Schemas.KNOWLEDGE_EMBEDDING_MODEL },
      });
      return { isSuccess: false, message, callCount: 0 };
    }

    const embedded = await KnowledgeEmbedProvider.embed(this.env, {
      companyPublicId,
      texts: chunks.map((chunk) => KnowledgeChunkerProvider.embeddingText(chunk)),
    });
    const calls = embedded.calls ?? [];
    if (calls.length > 0) {
      const recorded = await withTenant(this.db, companyId, async (tx) => {
        const result = await KnowledgeEmbedCallsProvider.record(tx, { companyId, price, calls });
        if (!result.isSuccess) throw new TenantRollbackError(result.message);
        return result;
      });
      if (!recorded.isSuccess) {
        AppLogger.error({
          category: Schemas.LogCategory.Knowledge,
          action: Schemas.LogAction.EmbedKnowledgeChunks,
          message: "Embedding calls were made but their model_calls rows could not be written",
          metadata: {
            companyId,
            calls: calls.length,
            inputTokens: calls.reduce((total, call) => total + call.inputTokens, 0),
            reason: recorded.message ?? null,
          },
        });
      }
    }

    if (!embedded.isSuccess || !embedded.embeddings) {
      return { isSuccess: false, message: embedded.message, callCount: calls.length };
    }
    const vectors = embedded.embeddings;
    return {
      isSuccess: true,
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        embedding: vectors[index] ?? [],
        embeddingModel: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
      })),
      callCount: calls.length,
    };
  }

  // DEV_NOTE: A web page's bytes are written to R2 first, as a new file (never overwriting the old one), so no lock is
  // held while they upload. Then one transaction: lock the owned source, re-read the document, write the new file row
  // (a new document, or replace the old file), update the document and replace its chunks. A transaction that doesn't
  // store the item (failed, or the run stopped) deletes the new object; a stored one deletes the replaced file's.
  private async storeDocument(
    params: Schemas.KnowledgeSyncItemParams,
    data: {
      companyPublicId: string;
      content: { bytes: Uint8Array<ArrayBuffer>; mime: string };
      title: string | null;
      contentHash: string;
      chunks: Schemas.EmbeddedKnowledgeChunk[];
    },
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    const sourceUrl = "url" in params.item ? params.item.url : null;
    let newFile: Pick<Schemas.StoredFile, "publicId" | "mime" | "sizeBytes" | "sha256"> | null =
      null;
    if (sourceUrl) {
      newFile = {
        publicId: Utility.generatePublicId(),
        mime: data.content.mime,
        sizeBytes: data.content.bytes.byteLength,
        sha256: await KnowledgeChunkerProvider.hashBytes(data.content.bytes),
      };
      const stored = await FileStorageProvider.putObject(this.env, {
        key: Schemas.fileR2Key(data.companyPublicId, newFile.publicId),
        bytes: data.content.bytes,
        mime: data.content.mime,
      });
      if (!stored.isSuccess) return { isSuccess: false, message: stored.message };
    }
    const now = new Date();
    let oldFileR2Key: string | null = null;

    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.IngestKnowledgeSyncItemResponse> => {
        const owned = await this.lockOwnedSource(tx, params);
        if (!owned.isSuccess) throw new TenantRollbackError(owned.message);
        if (!owned.source) return this.stopped();
        const source = owned.source;

        const found = await this.findItemDocument(tx, params, source.id);
        if (!found.isSuccess && !found.isNotFound) throw new TenantRollbackError(found.message);
        let document = found.knowledgeDocument ?? null;

        if (!document) {
          // DEV_NOTE: An upload deleted while it was being embedded: this item is done, the sync goes on
          if (!newFile) {
            return {
              isSuccess: true,
              message: "Knowledge document is gone",
              outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Failed,
            };
          }
          const created = await KnowledgeDocumentFilesProvider.create(tx, {
            companyId: params.companyId,
            knowledgeSourceId: source.id,
            file: { ...newFile, filename: null, createdBy: null },
            document: {
              title: data.title,
              sourceUrl,
              contentHash: data.contentHash,
              indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
              lastSyncedAt: now,
            },
          });
          if (!created.isSuccess || !created.knowledgeDocument) {
            throw new TenantRollbackError(created.message);
          }
          document = created.knowledgeDocument;
        } else {
          let fileId: string | null = null;
          if (newFile) {
            const replaced = await KnowledgeDocumentFilesProvider.replaceFile(tx, {
              companyId: params.companyId,
              companyPublicId: data.companyPublicId,
              document,
              file: newFile,
            });
            if (!replaced.isSuccess || !replaced.fileId) {
              throw new TenantRollbackError(replaced.message);
            }
            fileId = replaced.fileId;
            oldFileR2Key = replaced.oldFileR2Key ?? null;
          }
          const updated = await this.documentsDal.updateKnowledgeDocument(tx, {
            id: document.id,
            companyId: params.companyId,
            title: data.title,
            contentHash: data.contentHash,
            indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
            lastSyncedAt: now,
            fileId,
          });
          if (!updated.isSuccess) throw new TenantRollbackError(updated.message);
        }

        const deleted = await this.chunksDal.deleteKnowledgeChunksByDocuments(tx, {
          companyId: params.companyId,
          knowledgeDocumentIds: [document.id],
        });
        if (!deleted.isSuccess) throw new TenantRollbackError(deleted.message);
        const chunks = await this.chunksDal.createKnowledgeChunks(tx, {
          companyId: params.companyId,
          knowledgeDocumentId: document.id,
          knowledgeSourceId: source.id,
          chunks: data.chunks,
        });
        if (!chunks.isSuccess) throw new TenantRollbackError(chunks.message);

        return {
          isSuccess: true,
          message: "Knowledge document indexed",
          outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Indexed,
        };
      },
    );

    const isStored =
      result.isSuccess &&
      "outcome" in result &&
      result.outcome === Schemas.KnowledgeSyncItemOutcomeEnum.Indexed;
    if (!isStored && newFile) {
      await FileStorageProvider.deleteObjects(this.env, {
        keys: [Schemas.fileR2Key(data.companyPublicId, newFile.publicId)],
      });
    }
    if (isStored && oldFileR2Key) {
      await FileStorageProvider.deleteObjects(this.env, { keys: [oldFileR2Key] });
    }
    return result;
  }

  // DEV_NOTE: Unchanged: only last_synced_at moves, under the lock and only while the run owns the source
  private async markUnchanged(
    params: Schemas.KnowledgeSyncItemParams,
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    return await this.updateItemDocument(params, {
      outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Unchanged,
      message: "Knowledge document unchanged",
      update: { indexStatus: null, lastSyncedAt: new Date() },
    });
  }

  // DEV_NOTE: An item that failed: its document (if it has one) is marked Failed, and the sync goes on with the next
  // item. Its stored chunks stay searchable until a later sync indexes it again.
  private async markFailed(
    params: Schemas.KnowledgeSyncItemParams,
    reason: string,
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    AppLogger.warn({
      category: Schemas.LogCategory.Knowledge,
      action: Schemas.LogAction.IngestKnowledgeSyncItem,
      message: "Knowledge sync item failed",
      metadata: { ...params, reason },
    });
    return await this.updateItemDocument(params, {
      outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Failed,
      message: reason,
      update: {
        indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Failed,
        lastSyncedAt: null,
      },
    });
  }

  private async updateItemDocument(
    params: Schemas.KnowledgeSyncItemParams,
    change: {
      outcome: Schemas.KnowledgeSyncItemOutcomeEnum;
      message: string;
      update: Pick<Schemas.UpdateKnowledgeDocumentDALRequest, "indexStatus" | "lastSyncedAt">;
    },
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.IngestKnowledgeSyncItemResponse> => {
        const owned = await this.lockOwnedSource(tx, params);
        if (!owned.isSuccess) throw new TenantRollbackError(owned.message);
        if (!owned.source) return this.stopped();

        const found = await this.findItemDocument(tx, params, owned.source.id);
        if (!found.isSuccess && !found.isNotFound) throw new TenantRollbackError(found.message);
        if (found.knowledgeDocument) {
          const updated = await this.documentsDal.updateKnowledgeDocument(tx, {
            id: found.knowledgeDocument.id,
            companyId: params.companyId,
            title: null,
            contentHash: null,
            fileId: null,
            ...change.update,
          });
          if (!updated.isSuccess) throw new TenantRollbackError(updated.message);
        }
        return {
          isSuccess: true,
          message: change.message,
          outcome: change.outcome,
          embedCallCount: 0,
        };
      },
    );
  }

  // DEV_NOTE: Locks the source row for the rest of the transaction and, while this run owns it, refreshes the run's
  // heartbeat. source is set only while the source is Syncing and owned by params.syncRunId.
  private async lockOwnedSource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.KnowledgeSyncWorkflowParams,
  ): Promise<Schemas.SyncingKnowledgeSourceResponse> {
    const owned = await this.findOwnedSource(tx, params, true);
    if (!owned.isSuccess || !owned.source) return owned;
    const touched = await this.sourcesDal.touchKnowledgeSourceSync(tx, {
      companyId: params.companyId,
      publicId: params.knowledgeSourcePublicId,
    });
    return touched.isSuccess ? owned : { isSuccess: false, message: touched.message };
  }

  private async findOwnedSource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.KnowledgeSyncWorkflowParams,
    isForUpdate: boolean,
  ): Promise<Schemas.SyncingKnowledgeSourceResponse> {
    const found = await this.sourcesDal.getKnowledgeSourceDetails(tx, {
      companyId: params.companyId,
      publicId: params.knowledgeSourcePublicId,
      isForUpdate,
    });
    if (!found.isSuccess && !found.isNotFound) return { isSuccess: false, message: found.message };
    const source = found.knowledgeSource;
    const isOwned =
      source?.status === Schemas.KnowledgeSourceStatusIntEnum.Syncing &&
      source.syncRunId === params.syncRunId;
    if (!source || !isOwned) return { isSuccess: true };

    const company = await this.companiesDal.getCompanyDetails(tx, { companyId: params.companyId });
    if (!company.isSuccess || !company.company) {
      return { isSuccess: false, message: company.message };
    }
    return { isSuccess: true, source, companyPublicId: company.company.publicId };
  }

  // DEV_NOTE: The document an item already has: by URL for a web page, by publicId for an upload
  private async findItemDocument(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.KnowledgeSyncItemParams,
    knowledgeSourceId: string,
  ): Promise<Schemas.KnowledgeDocumentDALResponse> {
    return "url" in params.item
      ? await this.documentsDal.getKnowledgeDocumentBySourceUrl(tx, {
          companyId: params.companyId,
          knowledgeSourceId,
          sourceUrl: params.item.url,
        })
      : await this.documentsDal.getKnowledgeDocumentDetails(tx, {
          companyId: params.companyId,
          knowledgeSourceId,
          publicId: params.item.knowledgeDocumentPublicId,
        });
  }

  private stopped(): Schemas.IngestKnowledgeSyncItemResponse {
    return {
      isSuccess: true,
      message: "Knowledge source is not syncing",
      outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Stopped,
    };
  }
}

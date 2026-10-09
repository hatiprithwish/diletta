import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeDocumentsDAL from "@/data-access-layer/KnowledgeDocumentsDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import FileStorageProvider from "@/providers/fileStorage";
import KnowledgeChunkerProvider from "@/providers/knowledgeChunker";
import KnowledgeDocumentFilesProvider from "@/providers/knowledgeDocumentFiles";
import KnowledgeEmbedProvider from "@/providers/knowledgeEmbed";
import KnowledgeExtractProvider from "@/providers/knowledgeExtract";
import KnowledgeFetchProvider from "@/providers/knowledgeFetch";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The steps of one source sync (M2-5), each called from its own KnowledgeSyncWorkflow step, each opening its
// own withTenant transactions (companyId: the internal id from the workflow params, set server-side at the claim).
//
// Per item: fetch (web) or read from R2 (upload) → convert to markdown → normalize → content_hash. A document whose
// stored hash matches and that is Indexed is Unchanged: its last_synced_at moves, nothing is chunked and no embed call
// is made. Otherwise it is chunked and embedded (one model_calls row per Workers AI call, tier Embed, usage Estimated),
// then one transaction stores it: the source row is locked FOR UPDATE and must still be Syncing (a pause or a delete
// takes the same lock, so a stopped sync writes nothing more), then the file and its R2 object, the document, and its
// chunks (old ones deleted, new ones written). Any failed write rolls the whole item back.
export default class KnowledgeIngestionRepo {
  private env: Env;
  private db: NodePgDatabase;
  private sourcesDal: KnowledgeSourcesDAL;
  private documentsDal: KnowledgeDocumentsDAL;
  private chunksDal: KnowledgeChunksDAL;
  private filesDal: FilesDAL;
  private companiesDal: CompaniesDAL;
  private modelCallsDal: ModelCallsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.sourcesDal = new KnowledgeSourcesDAL();
    this.documentsDal = new KnowledgeDocumentsDAL();
    this.chunksDal = new KnowledgeChunksDAL();
    this.filesDal = new FilesDAL();
    this.companiesDal = new CompaniesDAL();
    this.modelCallsDal = new ModelCallsDAL();
  }

  // DEV_NOTE: Round 0 lists the whole source: a sitemap's pages, a url source's one page, or every document of an
  // upload source. Later rounds (upload sources only) list the documents still Pending: files uploaded while the sync
  // ran. A source that is gone or no longer Syncing (paused) stops the sync.
  async listSyncItems(
    params: Schemas.KnowledgeSyncWorkflowParams & { round: number },
  ): Promise<Schemas.ListKnowledgeSyncItemsResponse> {
    const found = await withTenant(this.db, params.companyId, async (tx) => {
      return await this.sourcesDal.getKnowledgeSourceDetails(tx, {
        companyId: params.companyId,
        publicId: params.knowledgeSourcePublicId,
        isForUpdate: false,
      });
    });
    const source = "knowledgeSource" in found ? found.knowledgeSource : undefined;
    if (!found.isSuccess && !found.isNotFound) {
      return { isSuccess: false, message: found.message };
    }
    if (!source || source.status !== Schemas.KnowledgeSourceStatusIntEnum.Syncing) {
      return { isSuccess: true, message: "Knowledge source is not syncing", isStopped: true };
    }

    if (source.type === Schemas.KnowledgeSourceTypeIntEnum.Upload) {
      const documents = await withTenant(this.db, params.companyId, async (tx) => {
        return await this.documentsDal.getKnowledgeDocumentsBySource(tx, {
          companyId: params.companyId,
          knowledgeSourceId: source.id,
          indexStatuses:
            params.round === 0 ? null : [Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending],
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
      };
    }

    // DEV_NOTE: Web sources are listed once (round 0): the listing is the whole site
    if (params.round > 0 || !source.url) {
      return { isSuccess: true, message: "Nothing more to list", items: [], isWebSource: true };
    }
    const host = KnowledgeFetchProvider.hostOf(source.url);
    if (source.type === Schemas.KnowledgeSourceTypeIntEnum.Url) {
      const url = host ? KnowledgeFetchProvider.normalizeUrl(source.url, host) : null;
      if (!url) {
        return { isSuccess: false, message: "Knowledge source URL is not crawlable" };
      }
      return {
        isSuccess: true,
        message: "Knowledge sync items listed successfully",
        items: [{ url }],
        isWebSource: true,
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
      return { isSuccess: false, message: listed.message };
    }
    return {
      isSuccess: true,
      message: "Knowledge sync items listed successfully",
      items: listed.urls.map((url) => ({ url })),
      isWebSource: true,
    };
  }

  async ingestSyncItem(
    params: Schemas.KnowledgeSyncWorkflowParams & { item: Schemas.KnowledgeSyncItem },
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    const context = await this.loadItemContext(params);
    if (!context.isSuccess) {
      return {
        isSuccess: false,
        message: context.message,
        outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Failed,
      };
    }
    if (context.isStopped || !context.source || !context.companyPublicId) {
      return {
        isSuccess: true,
        message: "Knowledge source is not syncing",
        outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Stopped,
      };
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

    const content = await this.loadContent(params, companyPublicId, existing);
    if (!content.isSuccess || !content.bytes || !content.mime) {
      return await this.markFailed(
        params,
        existing,
        content.message ?? "Document could not be read",
      );
    }

    const extracted = await KnowledgeExtractProvider.toText(this.env, {
      bytes: content.bytes,
      mime: content.mime,
    });
    const text = KnowledgeChunkerProvider.normalizeText(extracted.text ?? "");
    if (!extracted.isSuccess || !text) {
      return await this.markFailed(params, existing, extracted.message ?? "Document has no text");
    }

    // DEV_NOTE: The content_hash skip: an unchanged, already indexed document is never chunked or embedded again
    const contentHash = await KnowledgeChunkerProvider.hashText(text);
    if (
      existing &&
      existing.contentHash === contentHash &&
      existing.indexStatus === Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed
    ) {
      const touched = await withTenant(this.db, params.companyId, async (tx) => {
        return await this.documentsDal.updateKnowledgeDocument(tx, {
          id: existing.id,
          companyId: params.companyId,
          title: null,
          contentHash: null,
          indexStatus: null,
          lastSyncedAt: new Date(),
        });
      });
      return touched.isSuccess
        ? {
            isSuccess: true,
            message: "Knowledge document unchanged",
            outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Unchanged,
            embedCallCount: 0,
          }
        : {
            isSuccess: false,
            message: touched.message,
            outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Failed,
          };
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
      const failed = await this.markFailed(
        params,
        existing,
        embedded.message ?? "Embedding failed",
      );
      return { ...failed, embedCallCount: embedded.callCount };
    }

    const title =
      KnowledgeChunkerProvider.extractTitle(text) ??
      existing?.title ??
      ("url" in params.item ? this.titleFromUrl(params.item.url) : null);
    const stored = await this.storeDocument({
      ...params,
      source,
      companyPublicId,
      existing,
      bytes: content.bytes,
      mime: content.mime,
      isNewContent: !isUpload,
      title,
      contentHash,
      chunks: embedded.chunks,
    });
    return { ...stored, embedCallCount: embedded.callCount };
  }

  // DEV_NOTE: A web source's documents whose URL the finished listing no longer has (removed from the sitemap) are
  // deleted with their chunks, files and R2 objects. Only while the source is still Syncing (locked). An empty listing
  // prunes nothing: a site serving an empty sitemap for a moment must not wipe its knowledge.
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
    const result = await withTenant(this.db, params.companyId, async (tx) => {
      const locked = await this.lockSyncingSource(tx, params);
      if (!locked.isSuccess) throw new TenantRollbackError(locked.message);
      if (!locked.source || !locked.companyPublicId) {
        return {
          isSuccess: true,
          message: "Knowledge source is not syncing",
          deletedCount: 0,
          fileR2Keys: [],
        };
      }

      const unlisted = await this.documentsDal.getUnlistedKnowledgeDocuments(tx, {
        companyId: params.companyId,
        knowledgeSourceId: locked.source.id,
        listedSourceUrls: params.listedUrls,
      });
      if (!unlisted.isSuccess || !unlisted.knowledgeDocuments) {
        throw new TenantRollbackError(unlisted.message);
      }

      const removed = await KnowledgeDocumentFilesProvider.remove(tx, {
        companyId: params.companyId,
        companyPublicId: locked.companyPublicId,
        documents: unlisted.knowledgeDocuments,
      });
      if (!removed.isSuccess) throw new TenantRollbackError(removed.message);
      return removed;
    });

    if (!result.isSuccess || !("fileR2Keys" in result)) {
      return { isSuccess: false, message: result.message };
    }
    if (result.fileR2Keys && result.fileR2Keys.length > 0) {
      await FileStorageProvider.deleteObjects(this.env, { keys: result.fileR2Keys });
    }
    return {
      isSuccess: true,
      message: "Unlisted knowledge documents pruned",
      deletedCount: result.deletedCount ?? 0,
    };
  }

  // DEV_NOTE: Ends the sync: Active with last_synced_at = now, or Failed (the listing failed, or every item failed).
  // Only a source still Syncing is changed: a paused or deleted one stays as the admin left it.
  async finishSync(
    params: Schemas.KnowledgeSyncWorkflowParams & { isFailed: boolean },
  ): Promise<Schemas.ApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const locked = await this.lockSyncingSource(tx, params);
      if (!locked.isSuccess) return { isSuccess: false, message: locked.message };
      if (!locked.source) return { isSuccess: true, message: "Knowledge source is not syncing" };

      const finished = await this.sourcesDal.setKnowledgeSourceSyncState(tx, {
        companyId: params.companyId,
        publicId: params.knowledgeSourcePublicId,
        status: params.isFailed
          ? Schemas.KnowledgeSourceStatusIntEnum.Failed
          : Schemas.KnowledgeSourceStatusIntEnum.Active,
        lastSyncedAt: params.isFailed ? null : new Date(),
      });
      return { isSuccess: finished.isSuccess, message: finished.message };
    });
  }

  // DEV_NOTE: The source (only while Syncing), the company's public id (R2 keys, gateway metadata) and the document the
  // item already has, if any: by URL for a web page, by publicId for an upload
  private async loadItemContext(
    params: Schemas.KnowledgeSyncWorkflowParams & { item: Schemas.KnowledgeSyncItem },
  ): Promise<Schemas.KnowledgeSyncItemContextResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.KnowledgeSyncItemContextResponse> => {
        const found = await this.sourcesDal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.knowledgeSourcePublicId,
          isForUpdate: false,
        });
        if (!found.isSuccess && !found.isNotFound)
          return { isSuccess: false, message: found.message };
        const source = found.knowledgeSource;
        if (!source || source.status !== Schemas.KnowledgeSourceStatusIntEnum.Syncing) {
          return { isSuccess: true, isStopped: true };
        }

        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
        });
        if (!company.isSuccess || !company.company)
          return { isSuccess: false, message: company.message };

        const document =
          "url" in params.item
            ? await this.documentsDal.getKnowledgeDocumentBySourceUrl(tx, {
                companyId: params.companyId,
                knowledgeSourceId: source.id,
                sourceUrl: params.item.url,
              })
            : await this.documentsDal.getKnowledgeDocumentDetails(tx, {
                companyId: params.companyId,
                knowledgeSourceId: source.id,
                publicId: params.item.knowledgeDocumentPublicId,
              });
        if (!document.isSuccess && !document.isNotFound)
          return { isSuccess: false, message: document.message };

        return {
          isSuccess: true,
          isStopped: false,
          source,
          companyPublicId: company.company.publicId,
          existing: document.knowledgeDocument ?? null,
        };
      },
    );
  }

  // DEV_NOTE: The item's bytes: fetched for a web page (capped, supported types only), read back from R2 for an upload
  private async loadContent(
    params: Schemas.KnowledgeSyncWorkflowParams & { item: Schemas.KnowledgeSyncItem },
    companyPublicId: string,
    existing: Schemas.KnowledgeDocument | null,
  ): Promise<Schemas.KnowledgeFetchResponse> {
    if ("url" in params.item) {
      const fetched = await KnowledgeFetchProvider.fetchDocument(
        params.item.url,
        Constants.KNOWLEDGE_PAGE_MAX_BYTES,
      );
      if (fetched.isSuccess && !KnowledgeExtractProvider.isSupportedMime(fetched.mime ?? "")) {
        return {
          isSuccess: false,
          message: `Unsupported document type: ${fetched.mime || "none"}`,
        };
      }
      return fetched;
    }
    if (!existing) return { isSuccess: false, message: "Knowledge document not found" };

    const file = await withTenant(this.db, params.companyId, async (tx) => {
      return await this.filesDal.getFile(tx, { id: existing.fileId, companyId: params.companyId });
    });
    if (!file.isSuccess || !("file" in file) || !file.file) {
      return { isSuccess: false, message: file.message };
    }
    const object = await FileStorageProvider.getObject(this.env, {
      key: Schemas.fileR2Key(companyPublicId, file.file.publicId),
    });
    if (!object.isSuccess || !object.bytes) return { isSuccess: false, message: object.message };
    return { isSuccess: true, bytes: object.bytes, mime: file.file.mime };
  }

  // DEV_NOTE: Embeds every chunk (heading path + text) and writes one model_calls row per Workers AI call made, even
  // when a call failed: an embedding is billed to the platform either way. The price is checked first, so a model
  // missing from PLATFORM_MODEL_PRICES is refused before any call, never recorded at 0.
  private async embedChunks(
    companyId: string,
    companyPublicId: string,
    chunks: Schemas.KnowledgeChunkDraft[],
  ): Promise<Schemas.EmbedKnowledgeChunksResponse> {
    if (chunks.length === 0) {
      return { isSuccess: true, chunks: [], callCount: 0 };
    }
    const price = Schemas.getModelCallPrice(
      Schemas.PlatformModelProviderEnum.WorkersAi,
      Schemas.KNOWLEDGE_EMBEDDING_MODEL,
    );
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
      await withTenant(this.db, companyId, async (tx) => {
        for (const call of calls) {
          await this.modelCallsDal.createModelCall(tx, {
            companyId,
            chatbotId: null,
            chatbotUserId: null,
            conversationId: null,
            evalRunId: null,
            turnId: null,
            taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
            tier: Schemas.ModelCallTierIntEnum.Embed,
            provider: Schemas.PlatformModelProviderEnum.WorkersAi,
            model: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
            gatewayLogId: call.gatewayLogId,
            inputTokens: call.inputTokens,
            outputTokens: null,
            cachedTokens: 0,
            costUsd: Schemas.computeModelCallCostUsd(
              price,
              {
                inputTokens: call.inputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
              },
              true,
            ),
            latencyMs: call.latencyMs,
            wasEscalated: false,
            errorCode: call.errorCode,
            usageStatus: Schemas.ModelCallUsageStatusIntEnum.Estimated,
          });
        }
        return { isSuccess: true };
      });
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

  private async storeDocument(
    params: Schemas.KnowledgeSyncWorkflowParams & {
      item: Schemas.KnowledgeSyncItem;
      source: Schemas.KnowledgeSource;
      companyPublicId: string;
      existing: Schemas.KnowledgeDocument | null;
      bytes: Uint8Array<ArrayBuffer>;
      mime: string;
      isNewContent: boolean;
      title: string | null;
      contentHash: string;
      chunks: Schemas.EmbeddedKnowledgeChunk[];
    },
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    let writtenR2Key: string | null = null;
    const now = new Date();

    const result = await withTenant(this.db, params.companyId, async (tx) => {
      const locked = await this.lockSyncingSource(tx, params);
      if (!locked.isSuccess) throw new TenantRollbackError(locked.message);
      if (!locked.source) {
        return {
          isSuccess: true,
          message: "Knowledge source is not syncing",
          outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Stopped,
        };
      }

      let documentId: string;
      if (params.existing) {
        documentId = params.existing.id;
        if (params.isNewContent) {
          const sha256 = await KnowledgeChunkerProvider.hashBytes(params.bytes);
          const replaced = await KnowledgeDocumentFilesProvider.replaceContent(this.env, tx, {
            companyId: params.companyId,
            companyPublicId: params.companyPublicId,
            fileId: params.existing.fileId,
            bytes: params.bytes,
            mime: params.mime,
            sha256,
          });
          if (!replaced.isSuccess) throw new TenantRollbackError(replaced.message);
        }
        const updated = await this.documentsDal.updateKnowledgeDocument(tx, {
          id: documentId,
          companyId: params.companyId,
          title: params.title,
          contentHash: params.contentHash,
          indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
          lastSyncedAt: now,
        });
        if (!updated.isSuccess) throw new TenantRollbackError(updated.message);
      } else {
        const sourceUrl = "url" in params.item ? params.item.url : null;
        const created = await KnowledgeDocumentFilesProvider.create(this.env, tx, {
          companyId: params.companyId,
          companyPublicId: params.companyPublicId,
          knowledgeSourceId: params.source.id,
          bytes: params.bytes,
          mime: params.mime,
          sha256: await KnowledgeChunkerProvider.hashBytes(params.bytes),
          filename: null,
          createdBy: null,
          document: {
            title: params.title,
            sourceUrl,
            contentHash: params.contentHash,
            indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
            lastSyncedAt: now,
          },
        });
        writtenR2Key = created.fileR2Key ?? null;
        if (!created.isSuccess || !created.knowledgeDocument) {
          throw new TenantRollbackError(created.message);
        }
        documentId = created.knowledgeDocument.id;
      }

      const deleted = await this.chunksDal.deleteKnowledgeChunksByDocuments(tx, {
        companyId: params.companyId,
        knowledgeDocumentIds: [documentId],
      });
      if (!deleted.isSuccess) throw new TenantRollbackError(deleted.message);
      const chunks = await this.chunksDal.createKnowledgeChunks(tx, {
        companyId: params.companyId,
        knowledgeDocumentId: documentId,
        knowledgeSourceId: params.source.id,
        chunks: params.chunks,
      });
      if (!chunks.isSuccess) throw new TenantRollbackError(chunks.message);

      return {
        isSuccess: true,
        message: "Knowledge document indexed",
        outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Indexed,
      };
    });

    if (!result.isSuccess) {
      // DEV_NOTE: The rows rolled back; the object written for a new file has no row now, so it goes too
      if (writtenR2Key) {
        await FileStorageProvider.deleteObjects(this.env, { keys: [writtenR2Key] });
      }
      return await this.markFailed(
        params,
        params.existing,
        result.message ?? "Knowledge document could not be stored",
      );
    }
    return result;
  }

  // DEV_NOTE: An item that failed: its document (if it has one) is marked Failed, and the sync goes on with the next
  // item. Its stored chunks stay searchable until a later sync indexes it again.
  private async markFailed(
    params: Schemas.KnowledgeSyncWorkflowParams & { item: Schemas.KnowledgeSyncItem },
    existing: Schemas.KnowledgeDocument | null,
    reason: string,
  ): Promise<Schemas.IngestKnowledgeSyncItemResponse> {
    AppLogger.warn({
      category: Schemas.LogCategory.Knowledge,
      action: Schemas.LogAction.IngestKnowledgeSyncItem,
      message: "Knowledge sync item failed",
      metadata: { ...params, reason },
    });
    if (existing) {
      await withTenant(this.db, params.companyId, async (tx) => {
        return await this.documentsDal.updateKnowledgeDocument(tx, {
          id: existing.id,
          companyId: params.companyId,
          title: null,
          contentHash: null,
          indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Failed,
          lastSyncedAt: null,
        });
      });
    }
    return {
      isSuccess: true,
      message: reason,
      outcome: Schemas.KnowledgeSyncItemOutcomeEnum.Failed,
    };
  }

  // DEV_NOTE: Locks the source row for the rest of the transaction; source is set only while it is Syncing
  private async lockSyncingSource(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.KnowledgeSyncWorkflowParams,
  ): Promise<Schemas.SyncingKnowledgeSourceResponse> {
    const found = await this.sourcesDal.getKnowledgeSourceDetails(tx, {
      companyId: params.companyId,
      publicId: params.knowledgeSourcePublicId,
      isForUpdate: true,
    });
    if (!found.isSuccess && !found.isNotFound) return { isSuccess: false, message: found.message };
    if (
      !found.knowledgeSource ||
      found.knowledgeSource.status !== Schemas.KnowledgeSourceStatusIntEnum.Syncing
    ) {
      return { isSuccess: true };
    }
    const company = await this.companiesDal.getCompanyDetails(tx, { companyId: params.companyId });
    if (!company.isSuccess || !company.company)
      return { isSuccess: false, message: company.message };
    return {
      isSuccess: true,
      source: found.knowledgeSource,
      companyPublicId: company.company.publicId,
    };
  }

  // DEV_NOTE: A page with no heading is titled by the last segment of its path, or its host
  private titleFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      const segment = parsed.pathname.split("/").filter(Boolean).pop();
      const title = segment ? decodeURIComponent(segment).replace(/[-_]+/g, " ") : parsed.host;
      return title.slice(0, Constants.KNOWLEDGE_TITLE_MAX_CHARS);
    } catch {
      return null;
    }
  }
}

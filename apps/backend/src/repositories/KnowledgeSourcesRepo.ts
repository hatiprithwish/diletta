import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeDocumentsDAL from "@/data-access-layer/KnowledgeDocumentsDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import FileStorageProvider from "@/providers/fileStorage";
import KnowledgeChunkerProvider from "@/providers/knowledgeChunker";
import KnowledgeDocumentFilesProvider from "@/providers/knowledgeDocumentFiles";
import KnowledgeSyncWorkflowProvider from "@/providers/knowledgeSyncWorkflow";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Knowledge sources and their documents for the dashboard (M2-5), and the start of every sync. Tenant Repo:
// one withTenant per step, companyId from the signed-in admin (routes) or the Cron's platform read.
//
// A sync starts only through startSync: in one transaction the source row is locked FOR UPDATE and claimed (Syncing)
// unless it is paused or already syncing (a Syncing source whose sync went quiet for KNOWLEDGE_SYNC_STALE_MS may be
// claimed again: its workflow died), then the KnowledgeSyncWorkflow instance is created after the commit. A failed
// create puts the source in Failed, so it never sits in Syncing with nothing running. Pause, delete and the sync's own
// writes take the same row lock, so a paused or deleted source gets no more writes from a running sync.
export default class KnowledgeSourcesRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: KnowledgeSourcesDAL;
  private documentsDal: KnowledgeDocumentsDAL;
  private chunksDal: KnowledgeChunksDAL;
  private filesDal: FilesDAL;
  private companiesDal: CompaniesDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.dal = new KnowledgeSourcesDAL();
    this.documentsDal = new KnowledgeDocumentsDAL();
    this.chunksDal = new KnowledgeChunksDAL();
    this.filesDal = new FilesDAL();
    this.companiesDal = new CompaniesDAL();
  }

  private withStatusLabel(source: Schemas.KnowledgeSource): Schemas.KnowledgeSourceWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      createdBy: _createdBy,
      updatedBy: _updatedBy,
      ...rest
    } = source;
    return {
      ...rest,
      knowledgeSourceStatus: source.status,
      knowledgeSourceStatusLabel: Schemas.KNOWLEDGE_SOURCE_STATUS_LABEL_MAP[source.status],
      typeLabel: Schemas.KNOWLEDGE_SOURCE_TYPE_LABEL_MAP[source.type],
      syncFrequencyLabel:
        source.syncFrequency === null
          ? null
          : Schemas.KNOWLEDGE_SOURCE_SYNC_FREQUENCY_LABEL_MAP[source.syncFrequency],
    };
  }

  private withDocumentStatusLabel(
    document: Schemas.KnowledgeDocument,
  ): Schemas.KnowledgeDocumentWithStatus {
    const {
      id: _id,
      companyId: _companyId,
      knowledgeSourceId: _knowledgeSourceId,
      fileId: _fileId,
      contentHash: _contentHash,
      ...rest
    } = document;
    return {
      ...rest,
      knowledgeDocumentIndexStatus: document.indexStatus,
      knowledgeDocumentIndexStatusLabel:
        Schemas.KNOWLEDGE_DOCUMENT_INDEX_STATUS_LABEL_MAP[document.indexStatus],
    };
  }

  private withSourceResponse(
    result: Schemas.KnowledgeSourceDALResponse,
  ): Schemas.GetKnowledgeSourceApiResponse {
    const { knowledgeSource, ...rest } = result;
    return {
      ...rest,
      knowledgeSource: knowledgeSource ? this.withStatusLabel(knowledgeSource) : undefined,
    };
  }

  // DEV_NOTE: A web source starts its first sync straight away (every frequency, Manual included); an upload source
  // syncs when a file is uploaded. A first sync that can't start leaves the source Failed, and the response carries
  // the source as it now is (the create itself succeeded).
  async createKnowledgeSource(
    params: Schemas.CreateKnowledgeSourceApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.CreateKnowledgeSourceApiResponse> {
    const body = params.knowledgeSource;
    const isWeb = body.type !== Schemas.KnowledgeSourceTypeIntEnum.Upload;
    const created = await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.createKnowledgeSource(tx, {
        companyId: params.companyId,
        type: body.type,
        url: isWeb ? body.url : null,
        syncFrequency: isWeb ? body.syncFrequency : null,
        createdBy: params.adminId,
      });
    });
    if (!created.isSuccess || !("knowledgeSource" in created) || !created.knowledgeSource) {
      return { isSuccess: false, message: created.message };
    }
    if (!isWeb) {
      return this.withSourceResponse(created);
    }

    const synced = await this.startSync({
      companyId: params.companyId,
      publicId: created.knowledgeSource.publicId,
    });
    if (synced.knowledgeSource) {
      return {
        isSuccess: true,
        message: "Knowledge source created successfully",
        knowledgeSource: synced.knowledgeSource,
      };
    }
    return this.withSourceResponse(created);
  }

  async getKnowledgeSourceDetails(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetKnowledgeSourceApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getKnowledgeSourceDetails(tx, {
        ...params,
        isForUpdate: false,
      });
      return this.withSourceResponse(result);
    });
  }

  async getKnowledgeSources(
    params: Schemas.GetKnowledgeSourcesApiRequest & { companyId: string },
  ): Promise<Schemas.GetKnowledgeSourcesApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const { knowledgeSources, ...rest } = await this.dal.getKnowledgeSources(tx, {
        companyId: params.companyId,
        pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
        pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
        sortColumn: params.sortColumn ?? Schemas.KnowledgeSourceSortColumn.CreatedAt,
        sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
      });
      return {
        ...rest,
        knowledgeSources: knowledgeSources?.map((source) => this.withStatusLabel(source)),
      };
    });
  }

  async getKnowledgeSourcesCount(params: {
    companyId: string;
  }): Promise<Schemas.GetKnowledgeSourcesCountApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.getKnowledgeSourcesCount(tx, params);
    });
  }

  // DEV_NOTE: Pause: any state → Paused (a running sync stops at its next item). Resume: Paused → Active only; resuming
  // a source that isn't paused leaves its status alone (it may be syncing). A sync frequency is for web sources only.
  async updateKnowledgeSource(
    params: Schemas.UpdateKnowledgeSourceApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.UpdateKnowledgeSourceApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.UpdateKnowledgeSourceApiResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.knowledgeSource) return this.withSourceResponse(found);
        const source = found.knowledgeSource;
        const body = params.knowledgeSource;

        if (
          body.syncFrequency !== undefined &&
          source.type === Schemas.KnowledgeSourceTypeIntEnum.Upload
        ) {
          return {
            isSuccess: false,
            message: "Only a web source has a sync frequency",
            failure: Schemas.KnowledgeSourceFailureEnum.NotWebSource,
          };
        }

        const isResumingPaused =
          body.status === Schemas.KnowledgeSourceStatusIntEnum.Active &&
          source.status === Schemas.KnowledgeSourceStatusIntEnum.Paused;
        const status =
          body.status === Schemas.KnowledgeSourceStatusIntEnum.Paused || isResumingPaused
            ? body.status
            : null;

        const result = await this.dal.updateKnowledgeSource(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          syncFrequency: body.syncFrequency ?? null,
          status: status ?? null,
          updatedBy: params.adminId,
        });
        return this.withSourceResponse(result);
      },
    );
  }

  // DEV_NOTE: Deletes the source with every document, chunk and file row in one transaction, then the R2 objects.
  // A sync still running finds the source gone at its next item and stops.
  async deleteKnowledgeSource(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.ApiResponse> {
    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.KnowledgeRemovalResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          ...params,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.knowledgeSource) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const source = found.knowledgeSource;
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
        });
        if (!company.isSuccess || !company.company) throw new TenantRollbackError(company.message);

        const chunks = await this.chunksDal.deleteKnowledgeChunksBySource(tx, {
          companyId: params.companyId,
          knowledgeSourceId: source.id,
        });
        if (!chunks.isSuccess) throw new TenantRollbackError(chunks.message);
        const documents = await this.documentsDal.deleteKnowledgeDocumentsBySource(tx, {
          companyId: params.companyId,
          knowledgeSourceId: source.id,
        });
        if (!documents.isSuccess || !documents.knowledgeDocuments) {
          throw new TenantRollbackError(documents.message);
        }
        const files = await this.filesDal.deleteFiles(tx, {
          companyId: params.companyId,
          ids: documents.knowledgeDocuments.map((document) => document.fileId),
        });
        if (!files.isSuccess || !files.files) throw new TenantRollbackError(files.message);
        const deleted = await this.dal.deleteKnowledgeSource(tx, params);
        if (!deleted.isSuccess) throw new TenantRollbackError(deleted.message);

        const companyPublicId = company.company.publicId;
        return {
          isSuccess: true,
          message: "Knowledge source deleted successfully",
          fileR2Keys: files.files.map((file) => Schemas.fileR2Key(companyPublicId, file.publicId)),
        };
      },
    );

    const fileR2Keys = "fileR2Keys" in result ? (result.fileR2Keys ?? []) : [];
    if (result.isSuccess && fileR2Keys.length > 0) {
      await FileStorageProvider.deleteObjects(this.env, { keys: fileR2Keys });
    }
    return { isSuccess: result.isSuccess, message: result.message, isNotFound: result.isNotFound };
  }

  async startSync(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.SyncKnowledgeSourceApiResponse> {
    const now = Date.now();
    const claimed = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.ClaimKnowledgeSyncResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          ...params,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.knowledgeSource) return this.withSourceResponse(found);
        const source = found.knowledgeSource;

        if (source.status === Schemas.KnowledgeSourceStatusIntEnum.Paused) {
          return {
            isSuccess: false,
            message: "Knowledge source is paused",
            failure: Schemas.KnowledgeSourceFailureEnum.Paused,
          };
        }
        const isLiveSync =
          source.status === Schemas.KnowledgeSourceStatusIntEnum.Syncing &&
          now - source.updatedAt.getTime() < Constants.KNOWLEDGE_SYNC_STALE_MS;
        if (isLiveSync) {
          return {
            isSuccess: false,
            message: "Knowledge source is already syncing",
            failure: Schemas.KnowledgeSourceFailureEnum.AlreadySyncing,
          };
        }

        const result = await this.dal.setKnowledgeSourceSyncState(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          status: Schemas.KnowledgeSourceStatusIntEnum.Syncing,
          lastSyncedAt: null,
        });
        return { ...this.withSourceResponse(result), source: result.knowledgeSource };
      },
    );
    const claimedSource = "source" in claimed ? claimed.source : undefined;
    if (!claimed.isSuccess || !claimedSource) {
      return {
        isSuccess: false,
        message: claimed.message,
        isNotFound: claimed.isNotFound,
        failure: "failure" in claimed ? claimed.failure : undefined,
      };
    }

    const started = await KnowledgeSyncWorkflowProvider.start(this.env, {
      companyId: params.companyId,
      knowledgeSourcePublicId: params.publicId,
    });
    if (started.isSuccess) {
      return {
        isSuccess: true,
        message: "Knowledge sync started",
        knowledgeSource: this.withStatusLabel(claimedSource),
      };
    }

    // DEV_NOTE: Nothing is running for the claim, so the source must not stay in Syncing
    const failed = await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.setKnowledgeSourceSyncState(tx, {
        companyId: params.companyId,
        publicId: params.publicId,
        status: Schemas.KnowledgeSourceStatusIntEnum.Failed,
        lastSyncedAt: null,
      });
    });
    const { knowledgeSource } = this.withSourceResponse(
      "knowledgeSource" in failed ? failed : { isSuccess: false },
    );
    return { isSuccess: false, message: started.message, knowledgeSource };
  }

  // DEV_NOTE: Hourly Cron (KnowledgeResyncCron): due web sources and stale syncs across companies (withPlatform read),
  // each then started in its own company's withTenant through startSync, which re-checks its state under the lock
  async startDueSyncs(params: {
    companyIds: string[] | null;
  }): Promise<Schemas.StartDueKnowledgeSyncsResponse> {
    const now = Date.now();
    const due = await withPlatform(this.db, async (tx) => {
      return await this.dal.getDueKnowledgeSources(tx, {
        dailyBefore: new Date(now - Constants.KNOWLEDGE_DAILY_SYNC_MS),
        weeklyBefore: new Date(now - Constants.KNOWLEDGE_WEEKLY_SYNC_MS),
        staleBefore: new Date(now - Constants.KNOWLEDGE_SYNC_STALE_MS),
        limit: Constants.KNOWLEDGE_RESYNC_BATCH_SIZE,
      });
    });
    if (!due.isSuccess || !("knowledgeSources" in due) || !due.knowledgeSources) {
      return { isSuccess: false, message: due.message };
    }

    let startedCount = 0;
    let failedCount = 0;
    const sources = params.companyIds
      ? due.knowledgeSources.filter((source) => params.companyIds?.includes(source.companyId))
      : due.knowledgeSources;
    for (const source of sources) {
      const started = await this.startSync({
        companyId: source.companyId,
        publicId: source.publicId,
      });
      if (started.isSuccess) {
        startedCount++;
      } else if (!started.failure) {
        failedCount++;
      }
    }

    return { isSuccess: true, message: "Due knowledge syncs started", startedCount, failedCount };
  }

  // DEV_NOTE: Stores the file (row + R2 object) and a Pending document in one transaction, then starts a sync. A source
  // that is paused keeps the document Pending until it is resumed and synced; one already syncing picks it up in its
  // next round.
  async uploadKnowledgeDocument(
    params: Schemas.UploadKnowledgeDocumentApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.UploadKnowledgeDocumentApiResponse> {
    const mime = Schemas.resolveKnowledgeUploadMime(params.file);
    if (!mime) {
      return { isSuccess: false, message: "Unsupported file type" };
    }
    const bytes = new Uint8Array(await params.file.arrayBuffer());
    const sha256 = await KnowledgeChunkerProvider.hashBytes(bytes);
    let writtenR2Key: string | null = null;

    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.UploadKnowledgeDocumentApiResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.knowledgeSource) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.knowledgeSource.type !== Schemas.KnowledgeSourceTypeIntEnum.Upload) {
          return {
            isSuccess: false,
            message: "Files are uploaded to an upload source only",
            failure: Schemas.KnowledgeSourceFailureEnum.NotUploadSource,
          };
        }
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
        });
        if (!company.isSuccess || !company.company) throw new TenantRollbackError(company.message);

        const created = await KnowledgeDocumentFilesProvider.create(this.env, tx, {
          companyId: params.companyId,
          companyPublicId: company.company.publicId,
          knowledgeSourceId: found.knowledgeSource.id,
          bytes,
          mime,
          sha256,
          filename: params.file.name,
          createdBy: params.adminId,
          document: {
            title: params.file.name.slice(0, Constants.KNOWLEDGE_TITLE_MAX_CHARS),
            sourceUrl: null,
            contentHash: null,
            indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending,
            lastSyncedAt: null,
          },
        });
        writtenR2Key = created.fileR2Key ?? null;
        if (!created.isSuccess || !created.knowledgeDocument) {
          throw new TenantRollbackError(created.message);
        }
        return {
          isSuccess: true,
          message: "Knowledge document uploaded successfully",
          knowledgeDocument: this.withDocumentStatusLabel(created.knowledgeDocument),
        };
      },
    );

    if (!result.isSuccess) {
      if (writtenR2Key) {
        await FileStorageProvider.deleteObjects(this.env, { keys: [writtenR2Key] });
      }
      return result;
    }

    const synced = await this.startSync({ companyId: params.companyId, publicId: params.publicId });
    if (!synced.isSuccess && !synced.failure) {
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.UploadKnowledgeDocument,
        message: "Uploaded knowledge document stored, but its sync didn't start",
        metadata: {
          companyId: params.companyId,
          publicId: params.publicId,
          reason: synced.message ?? null,
        },
      });
    }
    return result;
  }

  async getKnowledgeDocuments(
    params: Schemas.GetKnowledgeDocumentsApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.GetKnowledgeDocumentsApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetKnowledgeDocumentsApiResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: false,
        });
        if (!found.isSuccess || !found.knowledgeSource) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const { knowledgeDocuments, ...rest } = await this.documentsDal.getKnowledgeDocuments(tx, {
          companyId: params.companyId,
          knowledgeSourceId: found.knowledgeSource.id,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.KnowledgeDocumentSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        return {
          ...rest,
          knowledgeDocuments: knowledgeDocuments?.map((document) =>
            this.withDocumentStatusLabel(document),
          ),
        };
      },
    );
  }

  async getKnowledgeDocumentsCount(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetKnowledgeDocumentsCountApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetKnowledgeDocumentsCountApiResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          ...params,
          isForUpdate: false,
        });
        if (!found.isSuccess || !found.knowledgeSource) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        return await this.documentsDal.getKnowledgeDocumentsCount(tx, {
          companyId: params.companyId,
          knowledgeSourceId: found.knowledgeSource.id,
        });
      },
    );
  }

  // DEV_NOTE: Only an uploaded document can be deleted on its own: a web page comes back at the next sync, so it goes
  // when it leaves the sitemap (or with its source)
  async deleteKnowledgeDocument(params: {
    companyId: string;
    publicId: string;
    documentPublicId: string;
  }): Promise<Schemas.DeleteKnowledgeDocumentApiResponse> {
    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.KnowledgeRemovalResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.knowledgeSource) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.knowledgeSource.type !== Schemas.KnowledgeSourceTypeIntEnum.Upload) {
          return {
            isSuccess: false,
            message: "Only an uploaded document can be deleted",
            failure: Schemas.KnowledgeSourceFailureEnum.NotUploadSource,
          };
        }
        const document = await this.documentsDal.getKnowledgeDocumentDetails(tx, {
          companyId: params.companyId,
          knowledgeSourceId: found.knowledgeSource.id,
          publicId: params.documentPublicId,
        });
        if (!document.isSuccess || !document.knowledgeDocument) {
          return { isSuccess: false, message: document.message, isNotFound: document.isNotFound };
        }
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
        });
        if (!company.isSuccess || !company.company) throw new TenantRollbackError(company.message);

        const removed = await KnowledgeDocumentFilesProvider.remove(tx, {
          companyId: params.companyId,
          companyPublicId: company.company.publicId,
          documents: [document.knowledgeDocument],
        });
        if (!removed.isSuccess) throw new TenantRollbackError(removed.message);
        return {
          isSuccess: true,
          message: "Knowledge document deleted successfully",
          fileR2Keys: removed.fileR2Keys,
        };
      },
    );

    const fileR2Keys = "fileR2Keys" in result ? (result.fileR2Keys ?? []) : [];
    if (result.isSuccess && fileR2Keys.length > 0) {
      await FileStorageProvider.deleteObjects(this.env, { keys: fileR2Keys });
    }
    return {
      isSuccess: result.isSuccess,
      message: result.message,
      isNotFound: result.isNotFound,
      failure: "failure" in result ? result.failure : undefined,
    };
  }
}

import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import KnowledgeChunksDAL from "@/data-access-layer/KnowledgeChunksDAL";
import KnowledgeDocumentsDAL from "@/data-access-layer/KnowledgeDocumentsDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import FilesDAL from "@/data-access-layer/FilesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AuditEventProvider from "@/providers/auditEvent";
import FileStorageProvider from "@/providers/fileStorage";
import KnowledgeChunkerProvider from "@/providers/knowledgeChunker";
import KnowledgeDocumentFilesProvider from "@/providers/knowledgeDocumentFiles";
import KnowledgeExtractProvider from "@/providers/knowledgeExtract";
import KnowledgeSyncWorkflowProvider from "@/providers/knowledgeSyncWorkflow";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Knowledge sources and their documents for the dashboard (M2-5), and the start of every sync. Tenant Repo:
// one withTenant per step, companyId from the signed-in admin (routes) or the Cron's platform read.
//
// A sync starts only through startSync: in one transaction the source row is locked FOR UPDATE and claimed (Syncing)
// unless it is paused or already syncing (a Syncing source whose sync went quiet for KNOWLEDGE_SYNC_STALE_MS may be
// claimed again: its workflow died), then the KnowledgeSyncWorkflow instance is created after the commit. A failed
// create puts the source in Failed, so it never sits in Syncing with nothing running. Pause, delete and the sync's own
// writes take the same row lock, so a paused or deleted source gets no more writes from a running sync.
//
// Every admin write records its audit row (M4-9) in its own transaction and returns its outbox ids for the route to
// relay; a sync the platform starts (the create's first sync, a resumed upload source, the Cron, the workflow) has none.
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
      syncRunId: _syncRunId,
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

  // DEV_NOTE: An admin's audit row in the write's transaction; a failure rolls the write back
  private async audit(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      adminId: string;
      entityType: Schemas.AuditEntityTypeEnum;
      entityAction: Schemas.AuditEntityActionEnum;
      entity: { id: string; publicId: string };
      label: string | null;
    },
  ): Promise<string> {
    const audited = await AuditEventProvider.record(tx, {
      companyId: params.companyId,
      actor: { actorType: Schemas.ActivityLogActorTypeIntEnum.Admin, actorId: params.adminId },
      entityType: params.entityType,
      entityAction: params.entityAction,
      entityId: params.entity.id,
      entityPublicId: params.entity.publicId,
      label: params.label,
    });
    if (!audited.isSuccess || !audited.outboxId) {
      throw new TenantRollbackError(audited.message ?? "Audit event not recorded");
    }
    return audited.outboxId;
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
  ): Promise<Schemas.WithOutboxIds<Schemas.CreateKnowledgeSourceApiResponse>> {
    const body = params.knowledgeSource;
    const isWeb = body.type !== Schemas.KnowledgeSourceTypeIntEnum.Upload;
    const created = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.KnowledgeSourceDALResponse & { outboxId?: string }> => {
        const result = await this.dal.createKnowledgeSource(tx, {
          companyId: params.companyId,
          name: body.name,
          type: body.type,
          url: isWeb ? body.url : null,
          syncFrequency: isWeb ? body.syncFrequency : null,
          createdBy: params.adminId,
        });
        if (!result.isSuccess || !result.knowledgeSource) return result;
        const outboxId = await this.audit(tx, {
          companyId: params.companyId,
          adminId: params.adminId,
          entityType: Schemas.AuditEntityTypeEnum.KnowledgeSource,
          entityAction: Schemas.AuditEntityActionEnum.Created,
          entity: result.knowledgeSource,
          label: result.knowledgeSource.name,
        });
        return { ...result, outboxId };
      },
    );
    if (!created.isSuccess || !("knowledgeSource" in created) || !created.knowledgeSource) {
      return { isSuccess: false, message: created.message };
    }
    const outboxIds = created.outboxId ? [created.outboxId] : [];
    const { outboxId: _outboxId, ...createdSource } = created;
    if (!isWeb) {
      return { ...this.withSourceResponse(createdSource), outboxIds };
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
        outboxIds,
      };
    }
    return { ...this.withSourceResponse(createdSource), outboxIds };
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

  // DEV_NOTE: The page of sources with each one's document count (M4-7's Documents column), in one withTenant
  async getKnowledgeSources(
    params: Schemas.GetKnowledgeSourcesApiRequest & { companyId: string },
  ): Promise<Schemas.GetKnowledgeSourcesApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetKnowledgeSourcesApiResponse> => {
        const page = await this.dal.getKnowledgeSources(tx, {
          companyId: params.companyId,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.KnowledgeSourceSortColumn.CreatedAt,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
          status: params.status ?? null,
        });
        if (!page.isSuccess || !page.knowledgeSources) {
          return { isSuccess: false, message: page.message };
        }
        const sources = page.knowledgeSources;

        const counted = await this.documentsDal.getKnowledgeDocumentCountsBySource(tx, {
          companyId: params.companyId,
          knowledgeSourceIds: sources.map((source) => source.id),
        });
        if (!counted.isSuccess || !counted.documentCounts) {
          return { isSuccess: false, message: counted.message };
        }
        const documentCounts = counted.documentCounts;

        return {
          isSuccess: true,
          message: page.message,
          knowledgeSources: sources.map((source) => ({
            ...this.withStatusLabel(source),
            documentCount: documentCounts[source.id] ?? 0,
          })),
        };
      },
    );
  }

  async getKnowledgeSourcesCount(params: {
    companyId: string;
  }): Promise<Schemas.GetKnowledgeSourcesCountApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      return await this.dal.getKnowledgeSourcesCount(tx, params);
    });
  }

  // DEV_NOTE: Pause: any state → Paused (a running sync stops at its next step). Resume: Paused → Active only; resuming
  // a source that isn't paused leaves its status alone (it may be syncing). A resumed upload source starts a sync for
  // the files uploaded while it was paused (web sources wait for their schedule or a manual sync). A sync frequency is
  // for web sources only.
  async updateKnowledgeSource(
    params: Schemas.UpdateKnowledgeSourceApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateKnowledgeSourceApiResponse>> {
    let isUploadResumed = false;
    const updated = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateKnowledgeSourceApiResponse>> => {
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
          name: body.name ?? null,
          syncFrequency: body.syncFrequency ?? null,
          status: status ?? null,
          updatedBy: params.adminId,
        });
        if (!result.isSuccess || !result.knowledgeSource) return this.withSourceResponse(result);
        const after = result.knowledgeSource;
        isUploadResumed =
          isResumingPaused && source.type === Schemas.KnowledgeSourceTypeIntEnum.Upload;

        // DEV_NOTE: Audited by what changed: a new name or frequency is Updated, a pause or resume its own row
        const actions: Schemas.AuditEntityActionEnum[] = [];
        if (after.name !== source.name || after.syncFrequency !== source.syncFrequency) {
          actions.push(Schemas.AuditEntityActionEnum.Updated);
        }
        if (
          status === Schemas.KnowledgeSourceStatusIntEnum.Paused &&
          source.status !== Schemas.KnowledgeSourceStatusIntEnum.Paused
        ) {
          actions.push(Schemas.AuditEntityActionEnum.Paused);
        } else if (isResumingPaused) {
          actions.push(Schemas.AuditEntityActionEnum.Resumed);
        }
        const outboxIds: string[] = [];
        for (const entityAction of actions) {
          outboxIds.push(
            await this.audit(tx, {
              companyId: params.companyId,
              adminId: params.adminId,
              entityType: Schemas.AuditEntityTypeEnum.KnowledgeSource,
              entityAction,
              entity: after,
              label: after.name,
            }),
          );
        }
        return { ...this.withSourceResponse(result), outboxIds };
      },
    );
    if (!isUploadResumed) return updated;

    const synced = await this.startSync({ companyId: params.companyId, publicId: params.publicId });
    return synced.knowledgeSource
      ? { ...updated, knowledgeSource: synced.knowledgeSource }
      : updated;
  }

  // DEV_NOTE: Deletes the source with every document, chunk and file row in one transaction, then the R2 objects.
  // A sync still running finds the source gone at its next step and stops.
  async deleteKnowledgeSource(params: {
    companyId: string;
    publicId: string;
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.ApiResponse>> {
    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.KnowledgeRemovalResponse>> => {
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

        const removed = await KnowledgeDocumentFilesProvider.removeBySource(tx, {
          companyId: params.companyId,
          companyPublicId: company.company.publicId,
          knowledgeSourceId: source.id,
        });
        if (!removed.isSuccess) throw new TenantRollbackError(removed.message);
        const deleted = await this.dal.deleteKnowledgeSource(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
        });
        if (!deleted.isSuccess) throw new TenantRollbackError(deleted.message);
        const outboxId = await this.audit(tx, {
          companyId: params.companyId,
          adminId: params.adminId,
          entityType: Schemas.AuditEntityTypeEnum.KnowledgeSource,
          entityAction: Schemas.AuditEntityActionEnum.Deleted,
          entity: source,
          label: source.name,
        });

        return {
          isSuccess: true,
          message: "Knowledge source deleted successfully",
          fileR2Keys: removed.fileR2Keys,
          outboxIds: [outboxId],
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
      outboxIds: "outboxIds" in result ? result.outboxIds : undefined,
    };
  }

  // DEV_NOTE: A sync the platform starts (the create's first sync, a resumed upload source, an upload, the Cron, the
  // workflow's follow-up): no audit row
  async startSync(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.SyncKnowledgeSourceApiResponse> {
    return await this.claimSync(params, null);
  }

  // DEV_NOTE: An admin's Sync now / Retry sync: the same claim, with its audit row in the claim's transaction (a refused
  // claim records nothing)
  async requestSync(params: {
    companyId: string;
    publicId: string;
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.SyncKnowledgeSourceApiResponse>> {
    return await this.claimSync(params, params.adminId);
  }

  private async claimSync(
    params: { companyId: string; publicId: string },
    adminId: string | null,
  ): Promise<Schemas.WithOutboxIds<Schemas.SyncKnowledgeSourceApiResponse>> {
    const now = Date.now();
    const syncRunId = `ks-${params.publicId}-${Utility.generateUlid()}`;
    const claimed = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ClaimKnowledgeSyncResponse>> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
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
        // DEV_NOTE: Live = its run refreshed the heartbeat recently (every step does); an admin's edit doesn't count
        const heartbeatAt = source.syncHeartbeatAt ?? source.updatedAt;
        const isLiveSync =
          source.status === Schemas.KnowledgeSourceStatusIntEnum.Syncing &&
          now - heartbeatAt.getTime() < Constants.KNOWLEDGE_SYNC_STALE_MS;
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
          syncRunId,
        });
        if (!result.isSuccess || !result.knowledgeSource || adminId === null) {
          return { ...this.withSourceResponse(result), source: result.knowledgeSource };
        }
        const outboxId = await this.audit(tx, {
          companyId: params.companyId,
          adminId,
          entityType: Schemas.AuditEntityTypeEnum.KnowledgeSource,
          entityAction: Schemas.AuditEntityActionEnum.SyncStarted,
          entity: result.knowledgeSource,
          label: result.knowledgeSource.name,
        });
        return {
          ...this.withSourceResponse(result),
          source: result.knowledgeSource,
          outboxIds: [outboxId],
        };
      },
    );
    // DEV_NOTE: The claim (and its audit row) committed whatever the workflow start does next
    const outboxIds = "outboxIds" in claimed ? claimed.outboxIds : undefined;
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
      syncRunId,
    });
    if (started.isSuccess) {
      return {
        isSuccess: true,
        message: "Knowledge sync started",
        knowledgeSource: this.withStatusLabel(claimedSource),
        outboxIds,
      };
    }

    // DEV_NOTE: Nothing is running for the claim, so the source must not stay in Syncing (unless a newer claim or a
    // pause took it meanwhile)
    const failed = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.KnowledgeSourceDALResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || found.knowledgeSource?.syncRunId !== syncRunId) return found;
        if (found.knowledgeSource.status !== Schemas.KnowledgeSourceStatusIntEnum.Syncing)
          return found;
        return await this.dal.setKnowledgeSourceSyncState(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          status: Schemas.KnowledgeSourceStatusIntEnum.Failed,
          lastSyncedAt: null,
          syncRunId: null,
        });
      },
    );
    const { knowledgeSource } = this.withSourceResponse(
      "knowledgeSource" in failed ? failed : { isSuccess: false },
    );
    return { isSuccess: false, message: started.message, knowledgeSource, outboxIds };
  }

  // DEV_NOTE: Hourly Cron (KnowledgeResyncCron): due web sources, Failed ones past their backoff and stale syncs across
  // companies (withPlatform read), each then started in its own company's withTenant through startSync, which
  // re-checks its state under the lock
  async startDueSyncs(params: {
    companyIds: string[] | null;
  }): Promise<Schemas.StartDueKnowledgeSyncsResponse> {
    const now = Date.now();
    const due = await withPlatform(this.db, async (tx) => {
      return await this.dal.getDueKnowledgeSources(tx, {
        dailyBefore: new Date(now - Constants.KNOWLEDGE_DAILY_SYNC_MS),
        weeklyBefore: new Date(now - Constants.KNOWLEDGE_WEEKLY_SYNC_MS),
        failedBefore: new Date(now - Constants.KNOWLEDGE_FAILED_RETRY_MS),
        staleBefore: new Date(now - Constants.KNOWLEDGE_SYNC_STALE_MS),
        companyIds: params.companyIds,
        limit: Constants.KNOWLEDGE_RESYNC_BATCH_SIZE,
      });
    });
    if (!due.isSuccess || !("knowledgeSources" in due) || !due.knowledgeSources) {
      return { isSuccess: false, message: due.message };
    }

    let startedCount = 0;
    let failedCount = 0;
    for (const source of due.knowledgeSources) {
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

  // DEV_NOTE: Writes the bytes to R2 first (a new file, named by a publicId generated here, so no source lock is held
  // while they upload), then stores the file row and a Pending document in one transaction, then starts a sync. The
  // object is deleted if the transaction doesn't commit. A paused source keeps the document Pending until it is
  // resumed; one already syncing picks it up in its next round or its follow-up sync.
  async uploadKnowledgeDocument(
    params: Schemas.UploadKnowledgeDocumentApiRequest & {
      companyId: string;
      publicId: string;
      adminId: string;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.UploadKnowledgeDocumentApiResponse>> {
    const mime = Schemas.resolveKnowledgeUploadMime(params.file);
    if (!mime) {
      return { isSuccess: false, message: "Unsupported file type" };
    }
    const bytes = new Uint8Array(await params.file.arrayBuffer());
    if (!KnowledgeExtractProvider.matchesType(bytes, mime)) {
      return {
        isSuccess: false,
        message: "File content doesn't match its type",
        failure: Schemas.KnowledgeSourceFailureEnum.UnreadableFile,
      };
    }

    const company = await withTenant(this.db, params.companyId, async (tx) => {
      return await this.companiesDal.getCompanyDetails(tx, { companyId: params.companyId });
    });
    if (!company.isSuccess || !("company" in company) || !company.company) {
      return { isSuccess: false, message: company.message };
    }
    const file = {
      publicId: Utility.generatePublicId(),
      filename: params.file.name,
      mime,
      sizeBytes: bytes.byteLength,
      sha256: await KnowledgeChunkerProvider.hashBytes(bytes),
      createdBy: params.adminId,
    };
    const fileR2Key = Schemas.fileR2Key(company.company.publicId, file.publicId);
    const stored = await FileStorageProvider.putObject(this.env, { key: fileR2Key, bytes, mime });
    if (!stored.isSuccess) return { isSuccess: false, message: stored.message };

    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UploadKnowledgeDocumentApiResponse>> => {
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

        const created = await KnowledgeDocumentFilesProvider.create(tx, {
          companyId: params.companyId,
          knowledgeSourceId: found.knowledgeSource.id,
          file,
          document: {
            title: params.file.name.slice(0, Constants.KNOWLEDGE_TITLE_MAX_CHARS),
            sourceUrl: null,
            contentHash: null,
            indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending,
            lastSyncedAt: null,
          },
        });
        if (!created.isSuccess || !created.knowledgeDocument) {
          throw new TenantRollbackError(created.message);
        }
        const outboxId = await this.audit(tx, {
          companyId: params.companyId,
          adminId: params.adminId,
          entityType: Schemas.AuditEntityTypeEnum.KnowledgeDocument,
          entityAction: Schemas.AuditEntityActionEnum.Uploaded,
          entity: created.knowledgeDocument,
          label: created.knowledgeDocument.title,
        });
        return {
          isSuccess: true,
          message: "Knowledge document uploaded successfully",
          knowledgeDocument: this.withDocumentStatusLabel(created.knowledgeDocument),
          outboxIds: [outboxId],
        };
      },
    );

    if (!result.isSuccess) {
      await FileStorageProvider.deleteObjects(this.env, { keys: [fileR2Key] });
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
          search: params.search ?? null,
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

  async getKnowledgeDocumentsCount(
    params: Schemas.GetKnowledgeDocumentsCountApiRequest & { companyId: string; publicId: string },
  ): Promise<Schemas.GetKnowledgeDocumentsCountApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetKnowledgeDocumentsCountApiResponse> => {
        const found = await this.dal.getKnowledgeSourceDetails(tx, {
          companyId: params.companyId,
          publicId: params.publicId,
          isForUpdate: false,
        });
        if (!found.isSuccess || !found.knowledgeSource) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        return await this.documentsDal.getKnowledgeDocumentsCount(tx, {
          companyId: params.companyId,
          knowledgeSourceId: found.knowledgeSource.id,
          search: params.search ?? null,
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
    adminId: string;
  }): Promise<Schemas.WithOutboxIds<Schemas.DeleteKnowledgeDocumentApiResponse>> {
    const result = await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.KnowledgeRemovalResponse>> => {
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
        const outboxId = await this.audit(tx, {
          companyId: params.companyId,
          adminId: params.adminId,
          entityType: Schemas.AuditEntityTypeEnum.KnowledgeDocument,
          entityAction: Schemas.AuditEntityActionEnum.Deleted,
          entity: document.knowledgeDocument,
          label: document.knowledgeDocument.title,
        });
        return {
          isSuccess: true,
          message: "Knowledge document deleted successfully",
          fileR2Keys: removed.fileR2Keys,
          outboxIds: [outboxId],
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
      outboxIds: "outboxIds" in result ? result.outboxIds : undefined,
    };
  }
}

import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import ChatbotUserSecretsDAL from "@/data-access-layer/ChatbotUserSecretsDAL";
import CompanyEncryptionKeysDAL from "@/data-access-layer/CompanyEncryptionKeysDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import ToolCallsDAL from "@/data-access-layer/ToolCallsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import AppLogger from "@/providers/logger";
import { recordAuditOrRollback, systemAuditActor } from "@/repositories/audit";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Every encrypted_* column the job moves, in the order it walks them
const ENCRYPTED_COLUMNS = [
  Schemas.EncryptedColumnEnum.CompanySecret,
  Schemas.EncryptedColumnEnum.ChatbotUserSecret,
  Schemas.EncryptedColumnEnum.ToolCallArgs,
  Schemas.EncryptedColumnEnum.ChangeRequestChanges,
];

// DEV_NOTE: The key rotation job (M6-3). A rotation (CompanyEncryptionKeysRepo) leaves the old key Retiring; this job
// finishes it, and re-wraps company keys after a master key rotation (docs/runbooks/master-key.md). Companies with work
// are listed across the platform (withPlatform); every read and write after that is the company's own (withTenant).
// Per company, in an order any step can fail and rerun from:
//   1. Each live key still wrapped by an older master key is wrapped again under the current one (compare-and-set).
//   2. Each encrypted_* column is walked by id, a batch per transaction: values on the Retiring key are decrypted and
//      encrypted again under the Active key with a fresh iv, saved only while the row still holds the version and iv
//      read (a value rewritten since keeps its new value). A value that fails is logged by id and walked past.
//   3. Once every column was walked to its end with nothing failed, one transaction locks the key rows, counts every
//      column again, and only at 0 destroys the Retiring key (encrypted_key nulled) with a System Retired audit row.
// No value can land on the Retiring key after the count: every write reads the Active key FOR SHARE, so the rotation
// waited for writes in flight under the old key before it committed. A key still Retiring past
// KEY_ROTATION_OVERDUE_ALERT_MS alerts (a value that won't decrypt keeps it there, and blocks the next rotation).
// Plaintext and key bytes stay inside CompanyKeyProvider; only ids and versions reach a log.
export default class KeyRotationRepo {
  private env: Env;
  private db: NodePgDatabase;
  private changeRequestsDal: ChangeRequestsDAL;
  private chatbotUserSecretsDal: ChatbotUserSecretsDAL;
  private companyEncryptionKeysDal: CompanyEncryptionKeysDAL;
  private companySecretsDal: CompanySecretsDAL;
  private toolCallsDal: ToolCallsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.changeRequestsDal = new ChangeRequestsDAL();
    this.chatbotUserSecretsDal = new ChatbotUserSecretsDAL();
    this.companyEncryptionKeysDal = new CompanyEncryptionKeysDAL();
    this.companySecretsDal = new CompanySecretsDAL();
    this.toolCallsDal = new ToolCallsDAL();
  }

  // DEV_NOTE: Right after a rotation's commit (the Security page), so a small company finishes in seconds; the cron
  // tick finishes what this doesn't reach
  static sweepCompanyInBackground(
    env: Env,
    ctx: { waitUntil(promise: Promise<unknown>): void },
    params: { companyId: string },
  ): void {
    ctx.waitUntil(
      new KeyRotationRepo(env).sweep({
        companyIds: [params.companyId],
        timeBudgetMs: Constants.KEY_ROTATION_KICK_TIME_BUDGET_MS,
      }),
    );
  }

  // DEV_NOTE: companyIds null = every company with work. masterKeyVersion, batchSize, timeBudgetMs and now default to
  // Constants / the clock (tests set them). isSuccess false = a read failed for some company; the others still ran.
  // Never throws.
  async sweep(
    params: {
      companyIds: string[] | null;
      masterKeyVersion?: number;
      now?: number;
      batchSize?: number;
      timeBudgetMs?: number;
    } = { companyIds: null },
  ): Promise<Schemas.KeyRotationSweepResponse> {
    const masterKeyVersion = params.masterKeyVersion ?? Constants.CURRENT_MASTER_KEY_VERSION;
    const now = params.now ?? Date.now();
    const batchSize = params.batchSize ?? Constants.KEY_ROTATION_BATCH_SIZE;
    const deadline = Date.now() + (params.timeBudgetMs ?? Constants.KEY_ROTATION_TIME_BUDGET_MS);
    const totals = {
      reEncryptedCount: 0,
      retiredCount: 0,
      rewrappedCount: 0,
      failedCount: 0,
      overdueCompanyCount: 0,
    };
    if (params.companyIds?.length === 0) {
      return { isSuccess: true, message: "No company to sweep", ...totals };
    }

    const listed: Schemas.CompanyIdsDALResponse = await withPlatform(
      this.db,
      async (tx) =>
        await this.companyEncryptionKeysDal.getCompanyIdsWithKeyWork(tx, {
          companyIds: params.companyIds,
          masterKeyVersion,
        }),
    );
    if (!listed.isSuccess || !listed.companyIds) {
      return { isSuccess: false, message: listed.message, ...totals };
    }

    let hasFailedRead = false;
    for (const companyId of listed.companyIds) {
      if (Date.now() >= deadline) break;
      const swept = await this.sweepCompany(companyId, {
        masterKeyVersion,
        now,
        batchSize,
        deadline,
      });
      totals.reEncryptedCount += swept.reEncryptedCount ?? 0;
      totals.retiredCount += swept.retiredCount ?? 0;
      totals.rewrappedCount += swept.rewrappedCount ?? 0;
      totals.failedCount += swept.failedCount ?? 0;
      totals.overdueCompanyCount += swept.overdueCompanyCount ?? 0;
      if (!swept.isSuccess) hasFailedRead = true;
    }

    return {
      isSuccess: !hasFailedRead,
      message: hasFailedRead
        ? "A company's encryption keys could not be swept"
        : "Encryption keys swept",
      ...totals,
    };
  }

  // DEV_NOTE: One company's steps 1–3. isSuccess false = its keys or a batch couldn't be read; what it reached stays done.
  private async sweepCompany(
    companyId: string,
    params: { masterKeyVersion: number; now: number; batchSize: number; deadline: number },
  ): Promise<Schemas.KeyRotationSweepResponse> {
    const response = {
      reEncryptedCount: 0,
      retiredCount: 0,
      rewrappedCount: 0,
      failedCount: 0,
      overdueCompanyCount: 0,
    };

    const listed: Schemas.CompanyEncryptionKeysDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx) => await this.companyEncryptionKeysDal.getCompanyEncryptionKeys(tx, { companyId }),
    );
    if (!listed.isSuccess || !listed.companyEncryptionKeys) {
      return { isSuccess: false, message: listed.message, ...response };
    }
    const keys = listed.companyEncryptionKeys;

    for (const key of keys) {
      if (
        key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed ||
        key.masterKeyVersion >= params.masterKeyVersion
      ) {
        continue;
      }
      const rewrapped: Schemas.CompanyEncryptionKeyDALResponse = await withTenant(
        this.db,
        companyId,
        async (tx) =>
          await CompanyKeyProvider.rewrapCompanyKey(this.env, tx, {
            companyEncryptionKey: key,
            masterKeyVersion: params.masterKeyVersion,
          }),
      );
      if (rewrapped.isSuccess) {
        response.rewrappedCount += 1;
      } else if (!rewrapped.isNotFound) {
        response.failedCount += 1;
      }
    }

    const retiringKey = keys.find(
      (key) => key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
    );
    if (!retiringKey) {
      return { isSuccess: true, message: "Company keys swept", ...response };
    }

    // DEV_NOTE: Only values left behind hold the key back; a key that failed to re-wrap above doesn't
    let failedValueCount = 0;
    let isWalkedToEnd = true;
    for (const column of ENCRYPTED_COLUMNS) {
      let afterId: string | null = null;
      let isColumnDone = false;
      while (!isColumnDone && Date.now() < params.deadline) {
        const fromId: string | null = afterId;
        const batch: Schemas.ReEncryptBatchResponse = await withTenant(
          this.db,
          companyId,
          async (tx) =>
            await this.reEncryptBatch(tx, {
              companyId,
              column,
              fromVersion: retiringKey.version,
              afterId: fromId,
              limit: params.batchSize,
            }),
        );
        if (!batch.isSuccess) {
          return {
            isSuccess: false,
            message: batch.message,
            ...response,
            failedCount: response.failedCount + failedValueCount,
          };
        }
        response.reEncryptedCount += batch.reEncryptedCount ?? 0;
        failedValueCount += batch.failedCount ?? 0;
        afterId = batch.lastId ?? null;
        isColumnDone = (batch.readCount ?? 0) < params.batchSize;
      }
      if (!isColumnDone) {
        isWalkedToEnd = false;
        break;
      }
    }

    response.failedCount += failedValueCount;

    if (isWalkedToEnd && failedValueCount === 0) {
      const retired: Schemas.RetireCompanyKeyResponse = await withTenant(
        this.db,
        companyId,
        async (tx) => await this.retireCompanyKey(tx, { companyId, version: retiringKey.version }),
      );
      if (!retired.isSuccess) {
        return { isSuccess: false, message: retired.message, ...response };
      }
      if (retired.isRetired) {
        response.retiredCount += 1;
        if (retired.outboxId) {
          await new EventOutboxRepo(this.env, this.db).relayEvents({
            companyId,
            outboxIds: [retired.outboxId],
          });
        }
        return { isSuccess: true, message: "Company keys swept", ...response };
      }
    }

    // DEV_NOTE: Rotated = the next version's created_at (the rotation creates it in the same transaction)
    const nextKey = keys
      .filter((key) => key.version > retiringKey.version)
      .sort((a, b) => a.version - b.version)[0];
    const rotatedAt = (nextKey ?? retiringKey).createdAt.getTime();
    if (params.now - rotatedAt >= Constants.KEY_ROTATION_OVERDUE_ALERT_MS) {
      response.overdueCompanyCount += 1;
      AppLogger.error({
        category: Schemas.LogCategory.Crypto,
        action: Schemas.LogAction.SweepKeyRotation,
        message: "Encryption key rotation is overdue",
        metadata: {
          companyId,
          version: retiringKey.version,
          retiringForMs: params.now - rotatedAt,
          failedCount: response.failedCount,
        },
      });
    }
    return { isSuccess: true, message: "Company keys swept", ...response };
  }

  // DEV_NOTE: Step 2, one transaction. A database failure throws TenantRollbackError (the transaction can't run another
  // statement after it), so the whole batch reruns next time; a value that won't decrypt is only counted and walked past.
  private async reEncryptBatch(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      column: Schemas.EncryptedColumnEnum;
      fromVersion: number;
      afterId: string | null;
      limit: number;
    },
  ): Promise<Schemas.ReEncryptBatchResponse> {
    const read = await this.getValuesOnKeyVersion(tx, params.column, {
      companyId: params.companyId,
      encryptionKeyVersion: params.fromVersion,
      afterId: params.afterId,
      limit: params.limit,
    });
    if (!read.isSuccess || !read.values) {
      throw new TenantRollbackError(read.message ?? "Values on key version not read");
    }
    const values = read.values;
    if (values.length === 0) {
      return { isSuccess: true, readCount: 0, reEncryptedCount: 0, failedCount: 0, lastId: null };
    }

    const reEncrypted = await CompanyKeyProvider.reEncryptValues(this.env, tx, {
      companyId: params.companyId,
      column: params.column,
      fromVersion: params.fromVersion,
      values,
    });
    if (
      !reEncrypted.isSuccess ||
      !reEncrypted.results ||
      reEncrypted.encryptionKeyVersion === undefined
    ) {
      throw new TenantRollbackError(reEncrypted.message ?? "Company keys not read");
    }

    let reEncryptedCount = 0;
    let failedCount = 0;
    for (const [index, result] of reEncrypted.results.entries()) {
      const value = values[index];
      if (!result.isSuccess || !result.encryptedValue || !value) {
        failedCount += 1;
        continue;
      }
      const updated = await this.updateReEncryptedValue(tx, params.column, {
        companyId: params.companyId,
        id: value.id,
        fromEncryptionKeyVersion: params.fromVersion,
        fromIv: value.encryptedValue.iv,
        encryptedValue: result.encryptedValue,
        encryptionKeyVersion: reEncrypted.encryptionKeyVersion,
      });
      if (!updated.isSuccess) {
        throw new TenantRollbackError(updated.message ?? "Re-encrypted value not saved");
      }
      if (updated.isUpdated) reEncryptedCount += 1;
    }

    return {
      isSuccess: true,
      message: "Batch re-encrypted",
      readCount: values.length,
      reEncryptedCount,
      failedCount,
      lastId: values[values.length - 1]?.id ?? null,
    };
  }

  // DEV_NOTE: Step 3, one transaction. The key rows are locked first (as a rotation locks them), then every column is
  // counted again: a value still on the key leaves it Retiring and writes nothing.
  private async retireCompanyKey(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; version: number },
  ): Promise<Schemas.RetireCompanyKeyResponse> {
    const locked = await this.companyEncryptionKeysDal.getCompanyEncryptionKeys(tx, {
      companyId: params.companyId,
      isForUpdate: true,
    });
    if (!locked.isSuccess || !locked.companyEncryptionKeys) {
      throw new TenantRollbackError(locked.message ?? "Encryption keys not read");
    }
    const isStillRetiring = locked.companyEncryptionKeys.some(
      (key) =>
        key.version === params.version &&
        key.status === Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
    );
    if (!isStillRetiring) {
      return { isSuccess: true, message: "Encryption key already retired", isRetired: false };
    }

    for (const column of ENCRYPTED_COLUMNS) {
      const counted = await this.getValuesOnKeyVersionCount(tx, column, {
        companyId: params.companyId,
        encryptionKeyVersion: params.version,
      });
      if (!counted.isSuccess || counted.totalRecords === undefined) {
        throw new TenantRollbackError(counted.message ?? "Values on key version not counted");
      }
      if (counted.totalRecords > 0) {
        return { isSuccess: true, message: "Values still on the key", isRetired: false };
      }
    }

    const destroyed = await this.companyEncryptionKeysDal.destroyCompanyEncryptionKey(tx, params);
    if (!destroyed.isSuccess || !destroyed.companyEncryptionKey) {
      throw new TenantRollbackError(destroyed.message ?? "Encryption key not destroyed");
    }
    const outboxId = await recordAuditOrRollback(tx, {
      companyId: params.companyId,
      actor: systemAuditActor(),
      entityType: Schemas.AuditEntityTypeEnum.CompanyEncryptionKey,
      entityAction: Schemas.AuditEntityActionEnum.Retired,
      entity: destroyed.companyEncryptionKey,
      entityVersion: params.version,
      label: `v${params.version}`,
    });

    return { isSuccess: true, message: "Encryption key retired", isRetired: true, outboxId };
  }

  private async getValuesOnKeyVersion(
    tx: NodePgTransaction<EmptyRelations>,
    column: Schemas.EncryptedColumnEnum,
    params: Schemas.GetValuesOnKeyVersionDALRequest,
  ): Promise<Schemas.ValuesOnKeyVersionDALResponse> {
    switch (column) {
      case Schemas.EncryptedColumnEnum.CompanySecret:
        return await this.companySecretsDal.getCompanySecretsOnKeyVersion(tx, params);
      case Schemas.EncryptedColumnEnum.ChatbotUserSecret:
        return await this.chatbotUserSecretsDal.getChatbotUserSecretsOnKeyVersion(tx, params);
      case Schemas.EncryptedColumnEnum.ToolCallArgs:
        return await this.toolCallsDal.getToolCallArgsOnKeyVersion(tx, params);
      case Schemas.EncryptedColumnEnum.ChangeRequestChanges:
        return await this.changeRequestsDal.getChangeRequestChangesOnKeyVersion(tx, params);
    }
  }

  private async updateReEncryptedValue(
    tx: NodePgTransaction<EmptyRelations>,
    column: Schemas.EncryptedColumnEnum,
    params: Schemas.UpdateReEncryptedValueDALRequest,
  ): Promise<Schemas.UpdateReEncryptedValueDALResponse> {
    switch (column) {
      case Schemas.EncryptedColumnEnum.CompanySecret:
        return await this.companySecretsDal.updateReEncryptedCompanySecret(tx, params);
      case Schemas.EncryptedColumnEnum.ChatbotUserSecret:
        return await this.chatbotUserSecretsDal.updateReEncryptedChatbotUserSecret(tx, params);
      case Schemas.EncryptedColumnEnum.ToolCallArgs:
        return await this.toolCallsDal.updateReEncryptedToolCallArgs(tx, params);
      case Schemas.EncryptedColumnEnum.ChangeRequestChanges:
        return await this.changeRequestsDal.updateReEncryptedChangeRequestChanges(tx, params);
    }
  }

  private async getValuesOnKeyVersionCount(
    tx: NodePgTransaction<EmptyRelations>,
    column: Schemas.EncryptedColumnEnum,
    params: Schemas.CountValuesOnKeyVersionDALRequest,
  ): Promise<Schemas.TotalRecordsResponse> {
    switch (column) {
      case Schemas.EncryptedColumnEnum.CompanySecret:
        return await this.companySecretsDal.getCompanySecretsOnKeyVersionCount(tx, params);
      case Schemas.EncryptedColumnEnum.ChatbotUserSecret:
        return await this.chatbotUserSecretsDal.getChatbotUserSecretsOnKeyVersionCount(tx, params);
      case Schemas.EncryptedColumnEnum.ToolCallArgs:
        return await this.toolCallsDal.getToolCallArgsOnKeyVersionCount(tx, params);
      case Schemas.EncryptedColumnEnum.ChangeRequestChanges:
        return await this.changeRequestsDal.getChangeRequestChangesOnKeyVersionCount(tx, params);
    }
  }
}

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import AiGatewayProvider from "@/providers/aiGateway";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Usage backfill for model_calls (M2-3). A call that reached the provider but ended without usage (stream
// cut or cancelled, connection lost) was still billed, so its row is Pending, never a silent $0. The per-minute Cron
// reads each Pending row's AI Gateway log once the row is MODEL_CALL_BACKFILL_MIN_AGE_MS old (the log is written after
// the call):
//   - log with token counts → Backfilled: tokens_in (no cache split in the log, so priced at the full input price:
//     an overcount, never an under) and tokens_out, costed from MODEL_PRICES.
//   - no log or no counts yet → stays Pending; past MODEL_CALL_BACKFILL_MAX_AGE_MS → Unknown + an error log.
//   - a failed lookup (API down, bad token) → stays Pending and is retried next minute, until the max age.
// The Pending read spans companies (withPlatform, pattern rule 3.15); each row is settled in its own company's
// withTenant, and only while still Pending, so overlapping sweeps never settle a row twice.
export default class ModelCallsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: ModelCallsDAL;

  constructor(env: Env) {
    this.env = env;
    this.db = getDbClient(env);
    this.dal = new ModelCallsDAL();
  }

  // DEV_NOTE: companyIds limits the sweep to some companies (tests on the shared staging branch); the Cron passes null
  async backfillPendingUsage(params: {
    companyIds: string[] | null;
  }): Promise<Schemas.BackfillModelCallUsageResponse> {
    const now = Date.now();
    const pending: Schemas.ModelCallsDALResponse = await withPlatform(this.db, async (tx) => {
      return await this.dal.getPendingModelCalls(tx, {
        companyIds: params.companyIds,
        createdBefore: new Date(now - Constants.MODEL_CALL_BACKFILL_MIN_AGE_MS),
        limit: Constants.MODEL_CALL_BACKFILL_BATCH_SIZE,
      });
    });
    if (!pending.isSuccess || !pending.modelCalls) {
      return { isSuccess: false, message: pending.message };
    }

    let backfilledCount = 0;
    let unknownCount = 0;
    let stillPendingCount = 0;
    for (const modelCall of pending.modelCalls) {
      const outcome = await this.backfillOne(modelCall, now);
      if (outcome === Schemas.ModelCallUsageStatusIntEnum.Backfilled) backfilledCount++;
      else if (outcome === Schemas.ModelCallUsageStatusIntEnum.Unknown) unknownCount++;
      else stillPendingCount++;
    }

    return {
      isSuccess: true,
      message: "Pending model call usage processed",
      backfilledCount,
      unknownCount,
      stillPendingCount,
    };
  }

  // DEV_NOTE: The status the row ends in (Pending when it stays for the next sweep)
  private async backfillOne(
    modelCall: Schemas.ModelCall,
    now: number,
  ): Promise<Schemas.ModelCallUsageStatusIntEnum> {
    const isPastWindow =
      now - modelCall.createdAt.getTime() > Constants.MODEL_CALL_BACKFILL_MAX_AGE_MS;
    const price = Schemas.getModelPrice(modelCall.provider, modelCall.model);
    const usage =
      modelCall.gatewayLogId && price
        ? await AiGatewayProvider.getLogUsage(this.env, modelCall.gatewayLogId)
        : null;

    if (usage?.isSuccess && usage.hasUsage && price) {
      const inputTokens = usage.inputTokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      return await this.settle(modelCall, {
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Backfilled,
        inputTokens,
        outputTokens,
        costUsd: Schemas.computeModelCallCostUsd(price, {
          inputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens,
        }),
      });
    }

    // DEV_NOTE: No log id or no price can never resolve; a missing log or count may still appear until the window ends
    const canNeverResolve = !modelCall.gatewayLogId || !price;
    if (canNeverResolve || isPastWindow) {
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.BackfillModelCallUsage,
        message: "Model call usage could not be backfilled; its cost is unknown",
        metadata: {
          companyId: modelCall.companyId,
          modelCallPublicId: modelCall.publicId,
          gatewayLogId: modelCall.gatewayLogId,
          provider: modelCall.provider,
          model: modelCall.model,
          lookup: usage?.message ?? null,
        },
      });
      return await this.settle(modelCall, {
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Unknown,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
    }

    return Schemas.ModelCallUsageStatusIntEnum.Pending;
  }

  private async settle(
    modelCall: Schemas.ModelCall,
    settlement: Omit<Schemas.SettleModelCallUsageDALRequest, "companyId" | "publicId">,
  ): Promise<Schemas.ModelCallUsageStatusIntEnum> {
    const settled = await withTenant(this.db, modelCall.companyId, async (tx) => {
      return await this.dal.settleModelCallUsage(tx, {
        companyId: modelCall.companyId,
        publicId: modelCall.publicId,
        ...settlement,
      });
    });
    // DEV_NOTE: A row another sweep settled first, or a failed write (logged by the DAL), counts as still pending here
    return settled.isSuccess ? settlement.usageStatus : Schemas.ModelCallUsageStatusIntEnum.Pending;
  }
}

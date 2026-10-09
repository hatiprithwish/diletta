import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import AiGatewayProvider from "@/providers/aiGateway";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: model_calls (M2-3): one row per call of a routed model, and the usage backfill.
//
// recordModelCall writes what the recording middleware (ModelCallRecordingProvider) saw, priced from MODEL_PRICES.
//
// A call that reached the provider but ended without usage (stream cut or cancelled, connection lost) was still
// billed, so its row is Pending, never a silent $0. The per-minute Cron reads each Pending row's AI Gateway log once
// the row is MODEL_CALL_BACKFILL_MIN_AGE_MS old (the log is written after the call):
//   - log with token counts → Backfilled. The log's tokens_in has no cache split, so every input token is priced at
//     the dearer of the input and cache-write prices (cache writes cost more on Anthropic): an overcount, never an
//     under. tokens_out at the output price.
//   - no log or no counts yet → stays Pending; past MODEL_CALL_BACKFILL_MAX_AGE_MS → Unknown + an error log.
//   - a failed lookup (API down, bad token) → stays Pending and is retried next minute, until the max age.
// The Pending read spans companies (withPlatform, pattern rule 3.15); each row is settled in its own company's
// withTenant, and only while still Pending, so overlapping sweeps never settle a row twice. Lookups run
// MODEL_CALL_BACKFILL_CONCURRENCY at a time, so a batch of slow ones still finishes well inside a minute. A row that
// stays Pending is marked as tried, and each sweep takes the least recently tried rows first, so rows whose log is
// late take turns with the rest instead of filling every batch for the whole window.
export default class ModelCallsRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: ModelCallsDAL;

  // DEV_NOTE: db is optional so the router can share its client (one pool per request)
  constructor(env: Env, db: NodePgDatabase = getDbClient(env)) {
    this.env = env;
    this.db = db;
    this.dal = new ModelCallsDAL();
  }

  // DEV_NOTE: Runs in the router's waitUntil, so it never throws: a failed write is logged and the call itself is
  // unaffected. An Unknown row is logged as an error too: its cost of 0 isn't a real price.
  async recordModelCall(params: {
    context: Schemas.ModelCallContext;
    record: Schemas.ModelCallRecord;
  }): Promise<void> {
    const { context, record } = params;
    const { request } = context;
    const metadata = {
      companyId: request.companyId,
      conversationId: request.conversationId,
      turnId: request.turnId,
      provider: context.provider,
      model: context.model,
      errorCode: record.errorCode,
    };

    if (record.usageStatus === Schemas.ModelCallUsageStatusIntEnum.Unknown) {
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.RecordModelCall,
        message: "Model call ended without usage or a gateway log id; its cost is unknown",
        metadata,
      });
    }

    const usage = record.usage ?? Schemas.ZERO_MODEL_CALL_USAGE;
    const result = await withTenant(this.db, request.companyId, async (tx) => {
      return await this.dal.createModelCall(tx, {
        companyId: request.companyId,
        chatbotId: request.chatbotId,
        chatbotUserId: request.chatbotUserId,
        conversationId: request.conversationId,
        evalRunId: request.evalRunId,
        turnId: request.turnId,
        taskType: request.taskType,
        tier: Schemas.MODEL_TIER_CALL_TIER_MAP[context.tier],
        provider: context.provider,
        model: context.model,
        gatewayLogId: record.gatewayLogId,
        inputTokens: usage.inputTokens,
        // DEV_NOTE: null = not reported (Pending or Unknown, the backfill may fill it); a refusal reports 0
        outputTokens: record.usage ? usage.outputTokens : null,
        cachedTokens: usage.cacheReadTokens,
        costUsd: Schemas.computeModelCallCostUsd(context.price, usage),
        latencyMs: record.latencyMs,
        // DEV_NOTE: The router never escalates on its own; the turn loop picks the tier and will pass this when it
        // retries a turn on a higher tier
        wasEscalated: false,
        errorCode: record.errorCode,
        usageStatus: record.usageStatus,
      });
    });
    if (!result.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.RecordModelCall,
        message: result.message ?? "Model call not recorded",
        metadata,
      });
    }
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

    const outcomes: Schemas.ModelCallUsageStatusIntEnum[] = [];
    const queue = [...pending.modelCalls];
    const worker = async () => {
      for (let modelCall = queue.shift(); modelCall; modelCall = queue.shift()) {
        outcomes.push(await this.backfillOne(modelCall, now));
      }
    };
    await Promise.all(
      Array.from({ length: Constants.MODEL_CALL_BACKFILL_CONCURRENCY }, async () => await worker()),
    );

    const count = (status: Schemas.ModelCallUsageStatusIntEnum) =>
      outcomes.filter((outcome) => outcome === status).length;
    return {
      isSuccess: true,
      message: "Pending model call usage processed",
      backfilledCount: count(Schemas.ModelCallUsageStatusIntEnum.Backfilled),
      unknownCount: count(Schemas.ModelCallUsageStatusIntEnum.Unknown),
      stillPendingCount: count(Schemas.ModelCallUsageStatusIntEnum.Pending),
    };
  }

  // DEV_NOTE: The status the row ends in (Pending when it stays for the next sweep)
  private async backfillOne(
    modelCall: Schemas.ModelCall,
    now: number,
  ): Promise<Schemas.ModelCallUsageStatusIntEnum> {
    const isPastWindow =
      now - modelCall.createdAt.getTime() > Constants.MODEL_CALL_BACKFILL_MAX_AGE_MS;
    const price = Schemas.getModelCallPrice(modelCall.provider, modelCall.model);
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
        // DEV_NOTE: Every input token counted as a cache write: computeModelCallCostUsd prices those at
        // cacheWriteUsdPerMTok, which the price table keeps ≥ the input price (ModelRouterCommon.test)
        costUsd: Schemas.computeModelCallCostUsd(price, {
          inputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: inputTokens,
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

    // DEV_NOTE: Still Pending: marked as tried, so the next sweep starts with rows tried longer ago
    await withTenant(this.db, modelCall.companyId, async (tx) => {
      return await this.dal.touchPendingModelCall(tx, {
        companyId: modelCall.companyId,
        publicId: modelCall.publicId,
      });
    });
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

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AiGatewayProvider from "@/providers/aiGateway";
import CompanyKeyProvider from "@/providers/companyKey";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Thrown out of a model call when the provider rejected the company's key. The key is already marked
// Invalid and the system issue opened by then; the caller shows MODEL_UNAVAILABLE_MESSAGE. The provider's error is
// kept as cause for the logs only.
export class ModelUnavailableError extends Error {
  readonly failure: Schemas.ModelRouterFailureEnum;

  constructor(failure: Schemas.ModelRouterFailureEnum, cause: unknown) {
    super(Schemas.MODEL_UNAVAILABLE_MESSAGE, { cause });
    this.name = "ModelUnavailableError";
    this.failure = failure;
  }
}

const ZERO_USAGE: Schemas.ModelCallUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

// DEV_NOTE: The model router (M2-3), the only way to a chat model (pattern rule 3.10). getModel:
//   1. tier (or the routing's defaultTier) → provider + model from the chatbot's config spec routing.
//   2. the model must be in MODEL_PRICES, so every call can be costed; else ModelNotPriced.
//   3. the company's active key for that provider, decrypted in withTenant; no active key → the key-failure path,
//      KeyUnavailable.
//   4. AiGatewayProvider builds the provider-native model on AI Gateway, wrapped in recording middleware: one
//      model_calls row per call (tokens, cost, latency, gateway log id, error code, usage status), and the key-failure
//      path when the provider rejects the key.
// Key-failure path, one withTenant: the key is marked Invalid if it still holds the value that was used, and the
// company's open System / Model error issue gets this provider (a new issue on the call's conversation if none is
// open, with its critical event; else the provider is added to the open issue's note). A call with no conversation
// (background job) only invalidates the key. The outbox row is relayed after the commit.
// Every response failure is shown to the widget as MODEL_UNAVAILABLE_MESSAGE; the reason is logged only.
export default class ModelRouterRepo {
  private env: Env;
  private db: NodePgDatabase;
  private ctx: Pick<ExecutionContext, "waitUntil">;
  private companySecretsDal: CompanySecretsDAL;
  private modelCallsDal: ModelCallsDAL;
  private qualityIssuesDal: QualityIssuesDAL;
  private eventOutboxRepo: EventOutboxRepo;

  // DEV_NOTE: ctx is the Worker's ExecutionContext or the Durable Object's state: model_calls rows and the outbox
  // relay run in its waitUntil, after the response, so they never delay a turn
  constructor(env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
    this.env = env;
    this.db = getDbClient(env);
    this.ctx = ctx;
    this.companySecretsDal = new CompanySecretsDAL();
    this.modelCallsDal = new ModelCallsDAL();
    this.qualityIssuesDal = new QualityIssuesDAL();
    this.eventOutboxRepo = new EventOutboxRepo(env);
  }

  async getModel(
    params: Schemas.GetModelRequest,
  ): Promise<Schemas.GetModelResponse<LanguageModel>> {
    const tier = params.tier ?? params.routing.defaultTier;
    const { provider, model } = params.routing[tier];
    const logMetadata = {
      companyId: params.companyId,
      conversationId: params.conversationId,
      turnId: params.turnId,
      tier,
      provider,
      model,
    };

    const price = Schemas.getModelPrice(provider, model);
    if (!price) {
      return this.reject(
        Schemas.ModelRouterFailureEnum.ModelNotPriced,
        "Model is not in the price table",
        logMetadata,
      );
    }

    const key: Schemas.DecryptedModelKeyResponse = await withTenant(
      this.db,
      params.companyId,
      async (tx) => {
        const found = await this.companySecretsDal.getActiveModelKey(tx, {
          companyId: params.companyId,
          provider,
        });
        if (!found.isSuccess || !found.companySecret) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }

        const { companySecret } = found;
        const decrypted = await CompanyKeyProvider.decryptCompanySecret(
          this.env,
          tx,
          companySecret,
        );
        return {
          ...decrypted,
          companySecret: {
            publicId: companySecret.publicId,
            iv: companySecret.iv,
            encryptionKeyVersion: companySecret.encryptionKeyVersion,
          },
        };
      },
    );

    if (!key.isSuccess || key.secret === undefined || !key.companySecret) {
      if (!key.isNotFound) {
        return this.reject(
          Schemas.ModelRouterFailureEnum.ServerError,
          key.message ?? "Model key could not be read",
          logMetadata,
        );
      }
      await this.handleKeyFailure({
        companyId: params.companyId,
        conversationId: params.conversationId,
        provider,
        usedKey: null,
        reason: Schemas.ModelKeyFailureReasonEnum.NoActiveKey,
      });
      return this.reject(
        Schemas.ModelRouterFailureEnum.KeyUnavailable,
        "No active model key for the provider",
        logMetadata,
      );
    }

    const created = await AiGatewayProvider.createModel(this.env, {
      provider,
      model,
      apiKey: key.secret,
      metadata: ModelRouterRepo.gatewayMetadata(params),
      middleware: this.buildRecordingMiddleware({
        request: params,
        tier,
        provider,
        model,
        price,
        usedKey: key.companySecret,
      }),
    });
    if (!created.isSuccess) {
      return this.reject(
        created.failure,
        created.message ?? "Gateway model could not be created",
        logMetadata,
      );
    }

    return { isSuccess: true, message: "Model routed successfully", model: created.model };
  }

  // DEV_NOTE: Wraps every call of the routed model. A call that returns usage is Reported. A call the provider
  // refused with an error status is Reported at 0 (providers don't bill a refusal). A call that reached the provider
  // but ended without usage (stream cut or cancelled, connection lost) is Pending when it has a gateway log id, for
  // the Cron backfill, else Unknown. A rejected key runs the key-failure path before the error reaches the caller, so
  // the next turn already finds no active key.
  private buildRecordingMiddleware(call: {
    request: Schemas.GetModelRequest;
    tier: Schemas.ModelTierEnum;
    provider: Schemas.ModelProviderEnum;
    model: string;
    price: Schemas.ModelPrice;
    usedKey: Pick<Schemas.CompanySecret, "publicId" | "iv" | "encryptionKeyVersion">;
  }): LanguageModelMiddleware {
    const record = (outcome: {
      usage: Schemas.ModelCallUsage | null;
      gatewayLogId: string | null;
      startedAt: number;
      errorCode: string | null;
    }) => {
      const usageStatus = outcome.usage
        ? Schemas.ModelCallUsageStatusIntEnum.Reported
        : outcome.gatewayLogId
          ? Schemas.ModelCallUsageStatusIntEnum.Pending
          : Schemas.ModelCallUsageStatusIntEnum.Unknown;
      this.ctx.waitUntil(
        this.recordModelCall(call, {
          usage: outcome.usage ?? ZERO_USAGE,
          hasOutputTokens: outcome.usage !== null,
          usageStatus,
          gatewayLogId: outcome.gatewayLogId,
          latencyMs: Date.now() - outcome.startedAt,
          errorCode: outcome.errorCode,
        }),
      );
    };

    const onCallError = async (error: unknown, startedAt: number): Promise<unknown> => {
      record({
        // DEV_NOTE: A refused call has nothing billed, so its zeros are real; anything else goes to the backfill
        usage: AiGatewayProvider.isRefusedCall(error) ? ZERO_USAGE : null,
        gatewayLogId: AiGatewayProvider.getGatewayLogIdFromError(error),
        startedAt,
        errorCode: AiGatewayProvider.getErrorCode(error),
      });
      if (!AiGatewayProvider.isRejectedKeyError(call.provider, error)) {
        return error;
      }
      await this.handleKeyFailure({
        companyId: call.request.companyId,
        conversationId: call.request.conversationId,
        provider: call.provider,
        usedKey: call.usedKey,
        reason: Schemas.ModelKeyFailureReasonEnum.RejectedByProvider,
      });
      return new ModelUnavailableError(Schemas.ModelRouterFailureEnum.KeyUnavailable, error);
    };

    return {
      wrapGenerate: async ({ doGenerate }) => {
        const startedAt = Date.now();
        try {
          const result = await doGenerate();
          record({
            usage: AiGatewayProvider.toModelCallUsage(result.usage),
            gatewayLogId: AiGatewayProvider.getGatewayLogId(result.response?.headers),
            startedAt,
            errorCode: null,
          });
          return result;
        } catch (error) {
          throw await onCallError(error, startedAt);
        }
      },
      wrapStream: async ({ doStream }) => {
        const startedAt = Date.now();
        let streamResult: Awaited<ReturnType<typeof doStream>>;
        try {
          streamResult = await doStream();
        } catch (error) {
          throw await onCallError(error, startedAt);
        }

        // DEV_NOTE: Usage arrives in the stream's finish part. The row is written once, when the stream ends, fails
        // or is cancelled; without a finish part the call was still billed, so it goes to the backfill.
        let usage: Schemas.ModelCallUsage | null = null;
        let errorCode: string | null = null;
        const gatewayLogId = AiGatewayProvider.getGatewayLogId(streamResult.response?.headers);
        const stream = Utility.observeStream(
          streamResult.stream,
          (part) => {
            if (part.type === "finish") {
              usage = AiGatewayProvider.toModelCallUsage(part.usage);
            } else if (part.type === "error") {
              errorCode = AiGatewayProvider.getErrorCode(part.error);
            }
          },
          ({ wasCancelled, error }) => {
            record({
              usage,
              gatewayLogId,
              startedAt,
              errorCode: error
                ? AiGatewayProvider.getErrorCode(error)
                : (errorCode ?? (wasCancelled ? "aborted" : null)),
            });
          },
        );
        return { ...streamResult, stream };
      },
    };
  }

  // DEV_NOTE: Key-failure path (see the class note). Never throws: a failure is logged and the caller still answers
  // KeyUnavailable. usedKey is the exact value the failed call used (null when there was no active key): if the admin
  // has replaced or revoked it since, the failure is stale and nothing changes. The advisory lock serialises
  // concurrent failures of one company, so only the first opens the issue and each provider is added to it once.
  private async handleKeyFailure(params: {
    companyId: string;
    conversationId: string | null;
    provider: Schemas.ModelProviderEnum;
    usedKey: Pick<Schemas.CompanySecret, "publicId" | "iv" | "encryptionKeyVersion"> | null;
    reason: Schemas.ModelKeyFailureReasonEnum;
  }): Promise<Schemas.HandleModelKeyFailureResponse> {
    const issueType = Schemas.QualityIssueTypeIntEnum.ModelError;
    const result: Schemas.HandleModelKeyFailureResponse = await withTenant(
      this.db,
      params.companyId,
      async (tx) => {
        if (params.usedKey !== null) {
          const invalidated = await this.companySecretsDal.invalidateModelKey(tx, {
            companyId: params.companyId,
            ...params.usedKey,
          });
          if (!invalidated.isSuccess) {
            throw new TenantRollbackError(invalidated.message);
          }
          if (!invalidated.companySecret) {
            return { isSuccess: true, message: "Model key changed since the call; nothing to do" };
          }
        }

        if (params.conversationId === null) {
          return {
            isSuccess: true,
            message: "Model key invalidated; no conversation to raise an issue on",
          };
        }

        const locked = await this.qualityIssuesDal.lockOpenSystemQualityIssue(tx, {
          companyId: params.companyId,
          issueType,
        });
        if (!locked.isSuccess) {
          throw new TenantRollbackError(locked.message);
        }

        const open = await this.qualityIssuesDal.getOpenSystemQualityIssue(tx, {
          companyId: params.companyId,
          issueType,
        });
        if (!open.isSuccess) {
          throw new TenantRollbackError(open.message);
        }

        const providerNote = ModelRouterRepo.keyFailureNote(params.provider, params.reason);
        if (open.qualityIssue) {
          // DEV_NOTE: One open issue per company, listing every provider that failed, so fixing one key doesn't
          // hide another that is still down
          const currentNote = open.qualityIssue.note ?? "";
          if (currentNote.includes(Schemas.MODEL_PROVIDER_LABEL_MAP[params.provider])) {
            return { isSuccess: true, message: "A system issue for this provider is already open" };
          }
          const extended = await this.qualityIssuesDal.updateQualityIssueNote(tx, {
            companyId: params.companyId,
            publicId: open.qualityIssue.publicId,
            note: currentNote ? `${currentNote}\n${providerNote}` : providerNote,
          });
          if (!extended.isSuccess) {
            throw new TenantRollbackError(extended.message);
          }
          return { isSuccess: true, message: "Provider added to the open system issue" };
        }

        const created = await this.qualityIssuesDal.createSystemQualityIssue(tx, {
          companyId: params.companyId,
          conversationId: params.conversationId,
          issueType,
          note: providerNote,
        });
        if (!created.isSuccess || !created.qualityIssue) {
          throw new TenantRollbackError(created.message);
        }

        const { qualityIssue } = created;
        const event = await CriticalEventProvider.record(tx, {
          companyId: params.companyId,
          actorType: Schemas.ActivityLogActorTypeIntEnum.System,
          actorId: null,
          entityType: "quality_issue",
          entityId: qualityIssue.id,
          entityAction: "opened",
          entityVersion: null,
          parentLogId: null,
          rootLogId: null,
          detail: {
            source: Schemas.QualityIssueSourceIntEnum.System,
            issueType,
            reason: params.reason,
            provider: params.provider,
            conversationId: params.conversationId,
          },
          eventType: "quality_issue.opened",
          dedupeKey: `quality_issue.opened:${qualityIssue.publicId}`,
        });
        if (!event.isSuccess || !event.outboxId) {
          throw new TenantRollbackError(event.message);
        }

        return {
          isSuccess: true,
          message: "System issue opened",
          qualityIssueId: qualityIssue.id,
          outboxId: event.outboxId,
        };
      },
    );

    if (!result.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.HandleModelKeyFailure,
        message: result.message ?? "Model key failure not recorded",
        metadata: {
          companyId: params.companyId,
          conversationId: params.conversationId,
          provider: params.provider,
          reason: params.reason,
        },
      });
      return result;
    }

    if (result.outboxId) {
      this.ctx.waitUntil(
        this.eventOutboxRepo.relayEvents({
          companyId: params.companyId,
          outboxIds: [result.outboxId],
        }),
      );
    }
    return result;
  }

  // DEV_NOTE: Runs in waitUntil, so it never throws: a failed write is logged and the call itself is unaffected.
  // An Unknown row is logged as an error too: its cost of 0 isn't a real price.
  private async recordModelCall(
    call: {
      request: Schemas.GetModelRequest;
      tier: Schemas.ModelTierEnum;
      provider: Schemas.ModelProviderEnum;
      model: string;
      price: Schemas.ModelPrice;
    },
    outcome: {
      usage: Schemas.ModelCallUsage;
      hasOutputTokens: boolean;
      usageStatus: Schemas.ModelCallUsageStatusIntEnum;
      gatewayLogId: string | null;
      latencyMs: number;
      errorCode: string | null;
    },
  ): Promise<void> {
    const { request } = call;
    const metadata = {
      companyId: request.companyId,
      conversationId: request.conversationId,
      turnId: request.turnId,
      provider: call.provider,
      model: call.model,
      errorCode: outcome.errorCode,
    };

    if (outcome.usageStatus === Schemas.ModelCallUsageStatusIntEnum.Unknown) {
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.RecordModelCall,
        message: "Model call ended without usage or a gateway log id; its cost is unknown",
        metadata,
      });
    }

    const result = await withTenant(this.db, request.companyId, async (tx) => {
      return await this.modelCallsDal.createModelCall(tx, {
        companyId: request.companyId,
        chatbotId: request.chatbotId,
        chatbotUserId: request.chatbotUserId,
        conversationId: request.conversationId,
        evalRunId: request.evalRunId,
        turnId: request.turnId,
        taskType: request.taskType,
        tier: Schemas.MODEL_TIER_CALL_TIER_MAP[call.tier],
        provider: call.provider,
        model: call.model,
        gatewayLogId: outcome.gatewayLogId,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.hasOutputTokens ? outcome.usage.outputTokens : null,
        cachedTokens: outcome.usage.cacheReadTokens,
        costUsd: Schemas.computeModelCallCostUsd(call.price, outcome.usage),
        latencyMs: outcome.latencyMs,
        // DEV_NOTE: The router never escalates on its own; the turn loop (M2-2) picks the tier and will pass this
        // when it retries a turn on a higher tier
        wasEscalated: false,
        errorCode: outcome.errorCode,
        usageStatus: outcome.usageStatus,
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

  // DEV_NOTE: A failure is logged once, here. A missing or rejected key is a warning: an expected state the system
  // issue covers.
  private reject(
    failure: Schemas.ModelRouterFailureEnum,
    message: string,
    metadata: Record<string, unknown>,
  ): Schemas.GetModelResponse<LanguageModel> {
    const entry = {
      category: Schemas.LogCategory.ModelRouter,
      action: Schemas.LogAction.GetModel,
      message,
      metadata,
    };
    if (failure === Schemas.ModelRouterFailureEnum.KeyUnavailable) {
      AppLogger.warn(entry);
    } else {
      AppLogger.error(entry);
    }
    return { isSuccess: false, message, failure };
  }

  // DEV_NOTE: cf-aig-metadata for cost attribution in the gateway's logs (5 entries max). Internal ids, as in our
  // own logs: the gateway is platform infrastructure, never a client. Unset ids are left out. A call belongs to a
  // conversation or an eval run, never both, so they share the one slot left.
  private static gatewayMetadata(params: Schemas.GetModelRequest): Record<string, string> {
    const entries: [string, string | null][] = [
      ["companyId", params.companyId],
      ["chatbotId", params.chatbotId],
      params.conversationId !== null
        ? ["conversationId", params.conversationId]
        : ["evalRunId", params.evalRunId],
      ["turnId", params.turnId],
      ["taskType", params.taskType],
    ];
    return Object.fromEntries(
      entries.filter((entry): entry is [string, string] => entry[1] !== null),
    );
  }

  // DEV_NOTE: One sentence per provider; the open issue's note gains a sentence for each provider that fails
  private static keyFailureNote(
    provider: Schemas.ModelProviderEnum,
    reason: Schemas.ModelKeyFailureReasonEnum,
  ): string {
    const label = Schemas.MODEL_PROVIDER_LABEL_MAP[provider];
    return reason === Schemas.ModelKeyFailureReasonEnum.NoActiveKey
      ? `There's no active ${label} model key, so the chatbot is temporarily unavailable. Add one in Settings › Model keys.`
      : `${label} rejected the model key, so the chatbot is temporarily unavailable. Replace it in Settings › Model keys.`;
  }
}

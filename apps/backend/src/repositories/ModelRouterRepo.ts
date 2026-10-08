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

// DEV_NOTE: The model router (M2-3), the only way to a chat model (pattern rule 3.10). getModel:
//   1. tier (or the routing's defaultTier) → provider + model from the chatbot's config spec routing.
//   2. the model must be in MODEL_PRICES, so every call can be costed; else ModelNotPriced.
//   3. the company's active key for that provider, decrypted in withTenant through CompanyKeyProvider; no active
//      key → the key-failure path, KeyUnavailable.
//   4. AiGatewayProvider builds the provider-native model on AI Gateway with the key, the gateway token and
//      cf-aig-metadata, wrapped in middleware that writes one model_calls row per call (tokens, cost, latency,
//      gateway log id, error code) and runs the key-failure path when the provider rejects the key.
// Key-failure path, one withTenant: the key (if any) is marked Invalid, and the company's System / ModelError issue
// opens on the call's conversation unless one is already open, with its critical event. A call with no conversation
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
        const decrypted = await CompanyKeyProvider.decryptValue(this.env, tx, {
          companyId: params.companyId,
          column: Schemas.EncryptedColumnEnum.CompanySecret,
          encryptedValue: { ciphertext: companySecret.encryptedSecret, iv: companySecret.iv },
          encryptionKeyVersion: companySecret.encryptionKeyVersion,
        });
        if (!decrypted.isSuccess || decrypted.plaintext === undefined) {
          return { isSuccess: false, message: decrypted.message };
        }

        return {
          isSuccess: true,
          message: "Model key decrypted successfully",
          secret: decrypted.plaintext,
          companySecretPublicId: companySecret.publicId,
        };
      },
    );

    if (!key.isSuccess || key.secret === undefined) {
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
        companySecretPublicId: null,
        reason: Schemas.ModelKeyFailureReasonEnum.NoActiveKey,
      });
      return this.reject(
        Schemas.ModelRouterFailureEnum.KeyUnavailable,
        "No active model key for the provider",
        logMetadata,
      );
    }

    const companySecretPublicId = key.companySecretPublicId ?? null;
    const recordCall = (call: {
      usage: Schemas.ModelCallUsage | null;
      gatewayLogId: string | null;
      latencyMs: number;
      errorCode: string | null;
    }) => {
      this.ctx.waitUntil(
        this.recordModelCall({
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          chatbotUserId: params.chatbotUserId,
          conversationId: params.conversationId,
          evalRunId: params.evalRunId,
          turnId: params.turnId,
          taskType: params.taskType,
          tier: Schemas.MODEL_TIER_CALL_TIER_MAP[tier],
          provider,
          model,
          gatewayLogId: call.gatewayLogId,
          inputTokens: call.usage?.inputTokens ?? 0,
          outputTokens: call.usage ? call.usage.outputTokens : null,
          cachedTokens: call.usage?.cacheReadTokens ?? 0,
          costUsd: Schemas.computeModelCallCostUsd(
            price,
            call.usage ?? {
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 0,
            },
          ),
          latencyMs: call.latencyMs,
          wasEscalated: false,
          errorCode: call.errorCode,
        }),
      );
    };

    // DEV_NOTE: A failed call is recorded too (no tokens, its error code). A key the provider rejects runs the
    // key-failure path before the error reaches the caller, so the next turn already finds no active key.
    const onCallError = async (error: unknown, startedAt: number): Promise<unknown> => {
      recordCall({
        usage: null,
        gatewayLogId: null,
        latencyMs: Date.now() - startedAt,
        errorCode: AiGatewayProvider.getErrorCode(error),
      });
      if (!AiGatewayProvider.isRejectedKeyError(provider, error)) {
        return error;
      }
      await this.handleKeyFailure({
        companyId: params.companyId,
        conversationId: params.conversationId,
        provider,
        companySecretPublicId,
        reason: Schemas.ModelKeyFailureReasonEnum.RejectedByProvider,
      });
      return new ModelUnavailableError(Schemas.ModelRouterFailureEnum.KeyUnavailable, error);
    };

    const middleware: LanguageModelMiddleware = {
      wrapGenerate: async ({ doGenerate }) => {
        const startedAt = Date.now();
        try {
          const result = await doGenerate();
          recordCall({
            usage: ModelRouterRepo.toModelCallUsage(result.usage),
            gatewayLogId: AiGatewayProvider.getGatewayLogId(result.response?.headers),
            latencyMs: Date.now() - startedAt,
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

        // DEV_NOTE: Usage arrives in the stream's finish part, so the row is written when the stream ends (or is
        // cancelled), once. An error part mid-stream is recorded as the call's error code.
        let usage: Schemas.ModelCallUsage | null = null;
        let errorCode: string | null = null;
        const gatewayLogId = AiGatewayProvider.getGatewayLogId(streamResult.response?.headers);
        const stream = ModelRouterRepo.observeStream(
          streamResult.stream,
          (part) => {
            if (part.type === "finish") {
              usage = ModelRouterRepo.toModelCallUsage(part.usage);
            } else if (part.type === "error") {
              errorCode = AiGatewayProvider.getErrorCode(part.error);
            }
          },
          (wasCancelled) => {
            recordCall({
              usage,
              gatewayLogId,
              latencyMs: Date.now() - startedAt,
              errorCode: errorCode ?? (wasCancelled ? "aborted" : null),
            });
          },
        );
        return { ...streamResult, stream };
      },
    };

    const created = await AiGatewayProvider.createModel(this.env, {
      provider,
      model,
      apiKey: key.secret,
      metadata: ModelRouterRepo.gatewayMetadata(params),
      middleware,
    });
    if (!created.isSuccess || !created.model) {
      return this.reject(
        created.failure ?? Schemas.ModelRouterFailureEnum.ServerError,
        created.message ?? "Gateway model could not be created",
        logMetadata,
      );
    }

    return { isSuccess: true, message: "Model routed successfully", model: created.model };
  }

  // DEV_NOTE: Key-failure path (see the class note). Never throws: a failure is logged and the caller still answers
  // KeyUnavailable. The advisory lock serialises concurrent failures of one company, so only the first opens the issue.
  private async handleKeyFailure(params: {
    companyId: string;
    conversationId: string | null;
    provider: Schemas.ModelProviderEnum;
    companySecretPublicId: string | null;
    reason: Schemas.ModelKeyFailureReasonEnum;
  }): Promise<Schemas.HandleModelKeyFailureResponse> {
    const issueType = Schemas.QualityIssueTypeIntEnum.ModelError;
    const result: Schemas.HandleModelKeyFailureResponse = await withTenant(
      this.db,
      params.companyId,
      async (tx) => {
        if (params.companySecretPublicId !== null) {
          const invalidated = await this.companySecretsDal.updateCompanySecret(tx, {
            companyId: params.companyId,
            publicId: params.companySecretPublicId,
            status: Schemas.CompanySecretStatusIntEnum.Invalid,
            encryptedSecret: null,
            iv: null,
            encryptionKeyVersion: null,
            lastFourChars: null,
            expiresAt: null,
          });
          if (!invalidated.isSuccess) {
            throw new TenantRollbackError(invalidated.message);
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
        if (open.qualityIssue) {
          return { isSuccess: true, message: "A system issue is already open" };
        }

        const created = await this.qualityIssuesDal.createSystemQualityIssue(tx, {
          companyId: params.companyId,
          conversationId: params.conversationId,
          issueType,
          note: ModelRouterRepo.keyFailureNote(params.provider, params.reason),
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

  // DEV_NOTE: Runs in waitUntil, so it never throws: a failed write is logged and the call itself is unaffected
  private async recordModelCall(params: Schemas.CreateModelCallDALRequest): Promise<void> {
    const result = await withTenant(this.db, params.companyId, async (tx) => {
      return await this.modelCallsDal.createModelCall(tx, params);
    });
    if (!result.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.RecordModelCall,
        message: result.message ?? "Model call not recorded",
        metadata: {
          companyId: params.companyId,
          conversationId: params.conversationId,
          turnId: params.turnId,
          provider: params.provider,
          model: params.model,
        },
      });
    }
  }

  private reject(
    failure: Schemas.ModelRouterFailureEnum,
    message: string,
    metadata: Record<string, unknown>,
  ): Schemas.GetModelResponse<LanguageModel> {
    AppLogger.error({
      category: Schemas.LogCategory.ModelRouter,
      action: Schemas.LogAction.GetModel,
      message,
      metadata,
    });
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

  private static keyFailureNote(
    provider: Schemas.ModelProviderEnum,
    reason: Schemas.ModelKeyFailureReasonEnum,
  ): string {
    const label = Schemas.MODEL_PROVIDER_LABEL_MAP[provider];
    return reason === Schemas.ModelKeyFailureReasonEnum.NoActiveKey
      ? `There's no active ${label} model key, so the chatbot is temporarily unavailable. Add one in Settings › Model keys.`
      : `${label} rejected the model key, so the chatbot is temporarily unavailable. Replace it in Settings › Model keys.`;
  }

  // DEV_NOTE: The provider's usage → our counts. Providers leave fields undefined when they don't report them.
  private static toModelCallUsage(usage: {
    inputTokens: {
      total: number | undefined;
      cacheRead: number | undefined;
      cacheWrite: number | undefined;
    };
    outputTokens: { total: number | undefined };
  }): Schemas.ModelCallUsage {
    return {
      inputTokens: usage.inputTokens.total ?? 0,
      cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
      cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
      outputTokens: usage.outputTokens.total ?? 0,
    };
  }

  // DEV_NOTE: Passes every part through unchanged, shows each to onPart, and calls onEnd exactly once: when the
  // stream finishes, errors or is cancelled by the reader (wasCancelled).
  private static observeStream<TPart>(
    source: ReadableStream<TPart>,
    onPart: (part: TPart) => void,
    onEnd: (wasCancelled: boolean) => void,
  ): ReadableStream<TPart> {
    let hasEnded = false;
    const end = (wasCancelled: boolean) => {
      if (hasEnded) return;
      hasEnded = true;
      onEnd(wasCancelled);
    };
    const reader = source.getReader();

    return new ReadableStream<TPart>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            end(false);
            controller.close();
            return;
          }
          onPart(value);
          controller.enqueue(value);
        } catch (error) {
          end(false);
          controller.error(error);
        }
      },
      async cancel(reason) {
        end(true);
        await reader.cancel(reason);
      },
    });
  }
}

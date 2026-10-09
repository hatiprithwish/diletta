import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LanguageModel } from "ai";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import AiGatewayProvider from "@/providers/aiGateway";
import CompanyKeyProvider from "@/providers/companyKey";
import AppLogger from "@/providers/logger";
import ModelCallRecordingProvider from "@/providers/modelCallRecording";
import ModelKeyFailureProvider from "@/providers/modelKeyFailure";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import ModelCallsRepo from "@/repositories/ModelCallsRepo";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The model router (M2-3), the only way to a chat model (pattern rule 3.10). getModel:
//   1. tier (or the routing's defaultTier) → provider + model from the chatbot's config spec routing.
//   2. the model must be in MODEL_PRICES, so every call can be costed; else ModelNotPriced.
//   3. the company's active key for that provider, decrypted in withTenant; no active key → the key-failure step,
//      KeyUnavailable.
//   4. AiGatewayProvider builds the provider-native model on AI Gateway, wrapped by ModelCallRecordingProvider: each
//      call is recorded (ModelCallsRepo.recordModelCall, in waitUntil), every failure becomes a ModelUnavailableError,
//      and a key the provider rejects runs the key-failure step (ModelKeyFailureProvider) before the error leaves.
// Every response failure is shown to the widget as MODEL_UNAVAILABLE_MESSAGE; the reason is logged only.
export default class ModelRouterRepo {
  private env: Env;
  private db: NodePgDatabase;
  private ctx: Pick<ExecutionContext, "waitUntil">;
  private companySecretsDal: CompanySecretsDAL;
  private modelCallsRepo: ModelCallsRepo;
  private eventOutboxRepo: EventOutboxRepo;

  // DEV_NOTE: ctx is the Worker's ExecutionContext or the Durable Object's state: model_calls rows and the outbox
  // relay run in its waitUntil, after the response, so they never delay a turn
  constructor(env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
    this.env = env;
    this.db = getDbClient(env);
    this.ctx = ctx;
    this.companySecretsDal = new CompanySecretsDAL();
    // DEV_NOTE: One pool for the whole call: the Repos it writes through share this client
    this.modelCallsRepo = new ModelCallsRepo(env, this.db);
    this.eventOutboxRepo = new EventOutboxRepo(env, this.db);
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

    const key = await this.getDecryptedModelKey(params.companyId, provider);
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

    const context: Schemas.ModelCallContext = {
      request: params,
      tier,
      provider,
      model,
      price,
      usedKey: key.companySecret,
    };
    const created = await AiGatewayProvider.createModel(this.env, {
      provider,
      model,
      apiKey: key.secret,
      metadata: ModelRouterRepo.gatewayMetadata(params),
      middleware: ModelCallRecordingProvider.createMiddleware({
        provider,
        onRecord: (record) => {
          this.ctx.waitUntil(this.modelCallsRepo.recordModelCall({ context, record }));
        },
        onRejectedKey: async () => {
          await this.handleKeyFailure({
            companyId: params.companyId,
            conversationId: params.conversationId,
            provider,
            usedKey: context.usedKey,
            reason: Schemas.ModelKeyFailureReasonEnum.RejectedByProvider,
          });
        },
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

  // DEV_NOTE: The provider's active key, decrypted, and which exact value it is (for a later invalidation).
  // isNotFound when the company has no active key for the provider.
  private async getDecryptedModelKey(
    companyId: string,
    provider: Schemas.ModelProviderEnum,
  ): Promise<Schemas.DecryptedModelKeyResponse> {
    return await withTenant(this.db, companyId, async (tx) => {
      const found = await this.companySecretsDal.getActiveModelKey(tx, { companyId, provider });
      if (!found.isSuccess || !found.companySecret) {
        return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
      }

      const { companySecret } = found;
      const decrypted = await CompanyKeyProvider.decryptCompanySecret(this.env, tx, companySecret);
      return {
        ...decrypted,
        companySecret: {
          publicId: companySecret.publicId,
          iv: companySecret.iv,
          encryptionKeyVersion: companySecret.encryptionKeyVersion,
        },
      };
    });
  }

  // DEV_NOTE: The key-failure step (ModelKeyFailureProvider) in one withTenant, then the outbox relay after the commit.
  // Never throws: a failure is logged and the caller still answers KeyUnavailable.
  private async handleKeyFailure(request: Schemas.ModelKeyFailureRequest): Promise<void> {
    const result: Schemas.HandleModelKeyFailureResponse = await withTenant(
      this.db,
      request.companyId,
      async (tx) => {
        const recorded = await ModelKeyFailureProvider.record(tx, request);
        if (!recorded.isSuccess) {
          throw new TenantRollbackError(recorded.message);
        }
        return recorded;
      },
    );

    if (!result.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.ModelRouter,
        action: Schemas.LogAction.HandleModelKeyFailure,
        message: result.message ?? "Model key failure not recorded",
        metadata: {
          companyId: request.companyId,
          conversationId: request.conversationId,
          provider: request.provider,
          reason: request.reason,
        },
      });
      return;
    }

    if (result.outboxId) {
      this.ctx.waitUntil(
        this.eventOutboxRepo.relayEvents({
          companyId: request.companyId,
          outboxIds: [result.outboxId],
        }),
      );
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
}

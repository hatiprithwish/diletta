import type { LanguageModelMiddleware } from "ai";
import AiGatewayProvider from "@/providers/aiGateway";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The only error a routed model's call ever raises, so no provider or gateway text (a 429 body, "prompt is
// too long: 212345 tokens", a stack) reaches the widget: Think sends a stream error's message to every socket as is.
// message is always MODEL_UNAVAILABLE_MESSAGE; failure says why, and the original error stays as cause for logs only.
// The caller's own abort is the one exception (see isAbort).
export class ModelUnavailableError extends Error {
  readonly failure: Schemas.ModelRouterFailureEnum;

  constructor(failure: Schemas.ModelRouterFailureEnum, cause: unknown) {
    super(Schemas.MODEL_UNAVAILABLE_MESSAGE, { cause });
    this.name = "ModelUnavailableError";
    this.failure = failure;
  }
}

// DEV_NOTE: Wraps every call of a routed model (generate and stream) to (1) record it: one ModelCallRecord per call,
// handed to onRecord, and (2) make every failure a ModelUnavailableError. Pure: no database. All the usage-status rules
// live here:
//   - the provider's usage arrived → Reported;
//   - the provider or gateway refused the call (status ≥ 400) → Reported at 0 (nothing billed);
//   - anything else (stream cut or cancelled, connection lost, unreadable 2xx, a finish without usage) → Pending when
//     there is a gateway log id to backfill from, else Unknown.
// A rejected company key runs onRejectedKey before the error leaves, so the next turn already finds no active key.
export default class ModelCallRecordingProvider {
  static createMiddleware(params: {
    provider: Schemas.ModelProviderEnum;
    onRecord: (record: Schemas.ModelCallRecord) => void;
    onRejectedKey: (error: unknown) => Promise<void>;
  }): LanguageModelMiddleware {
    const record = (outcome: {
      usage: Schemas.ModelCallUsage | null;
      isRefused: boolean;
      gatewayLogId: string | null;
      startedAt: number;
      errorCode: string | null;
    }) => {
      params.onRecord({
        usage: outcome.usage,
        usageStatus: ModelCallRecordingProvider.usageStatus(outcome),
        gatewayLogId: outcome.gatewayLogId,
        latencyMs: Date.now() - outcome.startedAt,
        errorCode: outcome.errorCode,
      });
    };

    // DEV_NOTE: A call that failed before any usage: record it, run the key-failure path when the key was rejected,
    // and return the error to throw
    const onCallError = async (error: unknown, startedAt: number): Promise<unknown> => {
      record({
        usage: null,
        isRefused: AiGatewayProvider.isRefusedCall(error),
        gatewayLogId: AiGatewayProvider.getGatewayLogIdFromError(error),
        startedAt,
        errorCode: AiGatewayProvider.getErrorCode(error),
      });
      if (!AiGatewayProvider.isRejectedKeyError(params.provider, error)) {
        return ModelCallRecordingProvider.toUnavailable(error);
      }
      await params.onRejectedKey(error);
      return new ModelUnavailableError(Schemas.ModelRouterFailureEnum.KeyUnavailable, error);
    };

    return {
      wrapGenerate: async ({ doGenerate }) => {
        const startedAt = Date.now();
        try {
          const result = await doGenerate();
          const usage = AiGatewayProvider.toModelCallUsage(result.usage);
          record({
            usage,
            isRefused: false,
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

        // DEV_NOTE: Usage arrives in the stream's finish part. The record is made once, when the stream ends, fails or
        // is cancelled. An error part is replaced with a ModelUnavailableError before Think reads it.
        let usage: Schemas.ModelCallUsage | null = null;
        let errorCode: string | null = null;
        const gatewayLogId = AiGatewayProvider.getGatewayLogId(streamResult.response?.headers);
        const stream = Utility.observeStream(streamResult.stream, {
          onChunk: (part) => {
            if (part.type === "finish") {
              usage = AiGatewayProvider.toModelCallUsage(part.usage);
            } else if (part.type === "error") {
              errorCode = AiGatewayProvider.getErrorCode(part.error);
              return { ...part, error: ModelCallRecordingProvider.toUnavailable(part.error) };
            }
            return part;
          },
          mapError: (error) => ModelCallRecordingProvider.toUnavailable(error),
          onEnd: ({ wasCancelled, error }) => {
            record({
              usage,
              isRefused: false,
              gatewayLogId,
              startedAt,
              errorCode: error
                ? AiGatewayProvider.getErrorCode(error)
                : (errorCode ?? (wasCancelled ? "aborted" : null)),
            });
          },
        });
        return { ...streamResult, stream };
      },
    };
  }

  // DEV_NOTE: Any failure as the one error the widget may see. An abort stays an abort.
  static toUnavailable(error: unknown): unknown {
    if (error instanceof ModelUnavailableError || AiGatewayProvider.isAbort(error)) {
      return error;
    }
    return new ModelUnavailableError(Schemas.ModelRouterFailureEnum.ProviderError, error);
  }

  private static usageStatus(outcome: {
    usage: Schemas.ModelCallUsage | null;
    isRefused: boolean;
    gatewayLogId: string | null;
  }): Schemas.ModelCallUsageStatusIntEnum {
    if (outcome.usage !== null || outcome.isRefused) {
      return Schemas.ModelCallUsageStatusIntEnum.Reported;
    }
    return outcome.gatewayLogId
      ? Schemas.ModelCallUsageStatusIntEnum.Pending
      : Schemas.ModelCallUsageStatusIntEnum.Unknown;
  }
}

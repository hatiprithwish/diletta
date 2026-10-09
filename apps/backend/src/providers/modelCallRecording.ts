import type { LanguageModelMiddleware } from "ai";
import Constants from "@/config/Constants";
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

// DEV_NOTE: Wraps every call of a routed model (generate and stream) to (1) retry what's worth retrying, (2) record
// every attempt: one ModelCallRecord per provider call, handed to onRecord, and (3) make every final failure a
// ModelUnavailableError. Pure: no database. All the usage-status rules live here:
//   - the provider's usage arrived → Reported;
//   - the call was refused before anything was billed (AiGatewayProvider.isRefusedCall) → Reported at 0;
//   - anything else (stream cut or cancelled, connection lost, unreadable 2xx, a finish without usage, a gateway
//     timeout) → Pending when there is a gateway log id to backfill from, else Unknown.
// Retries: an answer the SDK marks retryable (408 / 409 / 429 / 5xx) is tried again up to MODEL_CALL_MAX_RETRIES times
// before the call starts streaming, honouring retry-after (capped) and the caller's abort. They happen here because the
// SDK only retries its own retryable errors, and the middleware must hand it the safe error instead.
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
      const isRefusedWithoutUsage = outcome.isRefused && outcome.usage === null;
      params.onRecord({
        usage: isRefusedWithoutUsage ? Schemas.ZERO_MODEL_CALL_USAGE : outcome.usage,
        usageStatus: ModelCallRecordingProvider.usageStatus(outcome),
        gatewayLogId: outcome.gatewayLogId,
        latencyMs: Date.now() - outcome.startedAt,
        errorCode: outcome.errorCode,
      });
    };

    const recordFailedAttempt = (error: unknown, startedAt: number) => {
      record({
        usage: null,
        isRefused: AiGatewayProvider.isRefusedCall(error),
        gatewayLogId: AiGatewayProvider.getGatewayLogIdFromError(error),
        startedAt,
        errorCode: AiGatewayProvider.getErrorCode(error),
      });
    };

    // DEV_NOTE: The error to throw once retries are over: the key-failure step runs first for a rejected key
    const finalError = async (error: unknown): Promise<unknown> => {
      if (!AiGatewayProvider.isRejectedKeyError(params.provider, error)) {
        return ModelCallRecordingProvider.toUnavailable(error);
      }
      await params.onRejectedKey(error);
      return new ModelUnavailableError(Schemas.ModelRouterFailureEnum.KeyUnavailable, error);
    };

    // DEV_NOTE: Runs one provider call with retries; resolves with its result and when that attempt started
    const withRetries = async <TResult>(
      attempt: () => PromiseLike<TResult>,
      signal: AbortSignal | undefined,
    ): Promise<{ result: TResult; startedAt: number }> => {
      for (let retry = 0; ; retry++) {
        const startedAt = Date.now();
        try {
          return { result: await attempt(), startedAt };
        } catch (error) {
          recordFailedAttempt(error, startedAt);
          const canRetry =
            retry < Constants.MODEL_CALL_MAX_RETRIES &&
            AiGatewayProvider.isRetryable(error) &&
            !signal?.aborted;
          if (!canRetry) {
            throw await finalError(error);
          }
          await ModelCallRecordingProvider.waitBeforeRetry(retry, error, signal);
        }
      }
    };

    return {
      wrapGenerate: async ({ doGenerate, params: callOptions }) => {
        const { result, startedAt } = await withRetries(doGenerate, callOptions.abortSignal);
        record({
          usage: AiGatewayProvider.toModelCallUsage(result.usage),
          isRefused: false,
          gatewayLogId: AiGatewayProvider.getGatewayLogId(result.response?.headers),
          startedAt,
          errorCode: null,
        });
        return result;
      },
      wrapStream: async ({ doStream, params: callOptions }) => {
        const { result: streamResult, startedAt } = await withRetries(
          doStream,
          callOptions.abortSignal,
        );

        // DEV_NOTE: Usage arrives in the stream's finish part. The record is made once, when the stream ends, fails or
        // is cancelled. An error part is replaced with a ModelUnavailableError before Think reads it (no retry once
        // the reply has started streaming).
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

  // DEV_NOTE: The provider's retry-after when given (capped), else exponential; ends early (throwing the abort) when the
  // caller aborts meanwhile
  private static async waitBeforeRetry(
    retry: number,
    error: unknown,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const delayMs = Math.min(
      AiGatewayProvider.getRetryAfterMs(error) ?? Constants.MODEL_CALL_RETRY_BASE_MS * 2 ** retry,
      Constants.MODEL_CALL_RETRY_MAX_DELAY_MS,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
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

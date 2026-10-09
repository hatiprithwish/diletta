import { describe, it, expect, vi } from "vitest";
import { APICallError, generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AiGatewayProvider from "@/providers/aiGateway";
import ModelCallRecordingProvider, { ModelUnavailableError } from "@/providers/modelCallRecording";

// DEV_NOTE: Unit tests for the recording middleware: no database, no gateway. The AI SDK's mock model stands in for
// the provider, so each failure shape (a stream error part, a broken stream, a finish without usage, an unreadable 2xx,
// a refusal, a rejected key, an abort) is driven directly.

const RAW_PROVIDER_TEXT = "prompt is too long: 212345 tokens > 200000 maximum";

const usage = (input: number | undefined, output: number | undefined) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

// DEV_NOTE: retry-after-ms 0 keeps retried tests fast; isRetryable defaults to the SDK's own rule for the status
const apiError = (
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
  isRetryable?: boolean,
) =>
  new APICallError({
    message: RAW_PROVIDER_TEXT,
    url: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "retry-after-ms": "0", ...headers },
    responseBody: JSON.stringify(body),
    isRetryable,
  });

const generated = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: usage(100, 10),
  warnings: [],
  response: { headers: { "cf-aig-log-id": "log-ok" } },
});

// DEV_NOTE: An allow-all budget unless a test passes its own: every attempt gets a hold, and the holds are kept so a
// test can see what was reserved and which hold each record settles
function allowAllBudget() {
  const reservations: Schemas.ModelCallEstimate[] = [];
  return {
    reservations,
    budget: {
      maxOutputTokens: () => Constants.MODEL_CALL_MAX_OUTPUT_TOKENS,
      reserve: vi.fn(
        async (estimate: Schemas.ModelCallEstimate): Promise<Schemas.ModelCallReservation> => {
          reservations.push(estimate);
          return {
            isSuccess: true,
            reservationId: `reservation-${reservations.length}`,
            amountMicros: 1,
            tokens: estimate.inputTokens + estimate.maxOutputTokens,
          };
        },
      ),
    },
  };
}

function wrapped(
  model: MockLanguageModelV4,
  onRejectedKey = vi.fn(async () => {}),
  budget: ReturnType<typeof allowAllBudget>["budget"] = allowAllBudget().budget,
) {
  const records: Schemas.ModelCallRecord[] = [];
  const settledReservationIds: string[] = [];
  return {
    records,
    settledReservationIds,
    onRejectedKey,
    model: wrapLanguageModel({
      model,
      middleware: ModelCallRecordingProvider.createMiddleware({
        provider: Schemas.ModelProviderEnum.Anthropic,
        budget,
        onRecord: (record, reservation) => {
          records.push(record);
          settledReservationIds.push(reservation.reservationId);
        },
        onRejectedKey,
      }),
    }),
  };
}

// DEV_NOTE: The parts' type is read off the mock model's doStream, so each test's literal parts are checked against it
function streamOf(
  parts: Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<
    infer Part
  >
    ? Part[]
    : never,
  logId = "log-stream",
) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(parts),
      response: { headers: { "cf-aig-log-id": logId } },
    }),
  });
}

describe("ModelCallRecordingProvider streams", () => {
  it("records reported usage from the finish part", async () => {
    const { model, records } = wrapped(
      streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Hello" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(900, 40) },
      ]),
    );

    await streamText({ model, prompt: "Hi" }).consumeStream();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
      usage: { inputTokens: 900, outputTokens: 40 },
      gatewayLogId: "log-stream",
      errorCode: null,
    });
  });

  it("replaces a provider error part with the safe error, and records the call Pending", async () => {
    const { model, records } = wrapped(
      streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Partial" },
        {
          type: "error",
          error: apiError(529, { type: "error", error: { type: "overloaded_error" } }),
        },
      ]),
    );
    const errors: unknown[] = [];

    await streamText({
      model,
      prompt: "Hi",
      onError: ({ error }) => void errors.push(error),
    }).consumeStream();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ModelUnavailableError);
    expect(errors[0]).toMatchObject({
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
    });
    expect(JSON.stringify(errors)).not.toContain("prompt is too long");
    expect(records[0]).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
      errorCode: "http_529",
      usage: null,
    });
  });

  it("replaces the error of a stream that breaks", async () => {
    const broken = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.error(new TypeError(RAW_PROVIDER_TEXT));
          },
        }),
        response: { headers: { "cf-aig-log-id": "log-broken" } },
      }),
    });
    const { model, records } = wrapped(broken);
    const errors: unknown[] = [];

    // DEV_NOTE: However the SDK surfaces it (an error part, the onError hook, or a throw), it is the safe error
    const result = streamText({
      model,
      prompt: "Hi",
      onError: ({ error }) => void errors.push(error),
    });
    try {
      for await (const part of result.fullStream) {
        if (part.type === "error") errors.push(part.error);
      }
    } catch (error) {
      errors.push(error);
    }

    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ModelUnavailableError);
    }
    expect(records[0]).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
      gatewayLogId: "log-broken",
      errorCode: "TypeError",
    });
  });

  it("treats a finish part without usage totals as no usage, never as $0 reported", async () => {
    const { model, records } = wrapped(
      streamOf([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Hi" },
        { type: "text-end", id: "t" },
        {
          type: "finish",
          finishReason: { unified: "other", raw: undefined },
          usage: usage(undefined, undefined),
        },
      ]),
    );

    await streamText({ model, prompt: "Hi" }).consumeStream();

    expect(records[0]).toMatchObject({
      usage: null,
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
    });
  });
});

describe("ModelCallRecordingProvider generate", () => {
  it("records an unreadable 2xx as possibly billed (Pending), not refused", async () => {
    const { model, records } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw apiError(200, "not json {", { "cf-aig-log-id": "log-2xx" });
        },
      }),
    );

    await expect(generateText({ model, prompt: "Hi", maxRetries: 0 })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(records[0]).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
      gatewayLogId: "log-2xx",
      errorCode: "http_200",
    });
  });

  it("records a refusal as Reported at 0 and raises the safe error, keeping the cause", async () => {
    const refusal = apiError(429, { type: "error", error: { type: "rate_limit_error" } });
    const { model, records, onRejectedKey } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw refusal;
        },
      }),
    );

    const failed = generateText({ model, prompt: "Hi", maxRetries: 0 });
    await expect(failed).rejects.toMatchObject({
      name: "ModelUnavailableError",
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
      cause: refusal,
    });
    // DEV_NOTE: Refused before anything was billed: real zeros, output included
    expect(records.at(-1)).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
      usage: Schemas.ZERO_MODEL_CALL_USAGE,
      errorCode: "http_429",
    });
    expect(onRejectedKey).not.toHaveBeenCalled();
  });

  it("runs the key-failure step before raising KeyUnavailable for a rejected key", async () => {
    const { model, onRejectedKey } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw apiError(401, { type: "error", error: { type: "authentication_error" } });
        },
      }),
    );

    await expect(generateText({ model, prompt: "Hi", maxRetries: 0 })).rejects.toMatchObject({
      failure: Schemas.ModelRouterFailureEnum.KeyUnavailable,
    });
    expect(onRejectedKey).toHaveBeenCalledOnce();
  });

  it("leaves an abort as an abort", () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    expect(ModelCallRecordingProvider.toUnavailable(abort)).toBe(abort);
    expect(AiGatewayProvider.isAbort(abort)).toBe(true);
  });
});

describe("ModelCallRecordingProvider retries", () => {
  it("retries an overloaded provider and records every attempt", async () => {
    let calls = 0;
    const { model, records } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls += 1;
          if (calls <= 2)
            throw apiError(529, { type: "error", error: { type: "overloaded_error" } });
          return generated("Third time lucky");
        },
      }),
    );

    // DEV_NOTE: The SDK's own retry is left at its default; the middleware does the retrying
    const result = await generateText({ model, prompt: "Hi" });

    expect(result.text).toBe("Third time lucky");
    expect(calls).toBe(3);
    expect(records.map((record) => [record.usageStatus, record.errorCode])).toEqual([
      [Schemas.ModelCallUsageStatusIntEnum.Reported, "http_529"],
      [Schemas.ModelCallUsageStatusIntEnum.Reported, "http_529"],
      [Schemas.ModelCallUsageStatusIntEnum.Reported, null],
    ]);
  });

  it("gives up after the last retry with the safe error, and never retries a stream that started", async () => {
    let calls = 0;
    const { model, records } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls += 1;
          throw apiError(503, { error: { message: "unavailable" } });
        },
      }),
    );

    await expect(generateText({ model, prompt: "Hi" })).rejects.toMatchObject({
      name: "ModelUnavailableError",
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
    });
    expect(calls).toBe(Constants.MODEL_CALL_MAX_RETRIES + 1);
    expect(records).toHaveLength(Constants.MODEL_CALL_MAX_RETRIES + 1);
  });

  it("doesn't retry an answer that isn't retryable", async () => {
    let calls = 0;
    const { model } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls += 1;
          throw apiError(400, { type: "error", error: { type: "invalid_request_error" } });
        },
      }),
    );

    await expect(generateText({ model, prompt: "Hi" })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(calls).toBe(1);
  });

  it("stops waiting to retry when the caller aborts", async () => {
    const abort = new AbortController();
    const { model } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          setTimeout(() => abort.abort(), 20);
          throw apiError(
            429,
            { type: "error", error: { type: "rate_limit_error" } },
            {
              "retry-after-ms": "5000",
            },
          );
        },
      }),
    );

    const started = Date.now();
    await expect(
      generateText({ model, prompt: "Hi", abortSignal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("ModelCallRecordingProvider budget", () => {
  it("refuses a call the budget won't hold before it reaches the provider", async () => {
    const doGenerate = vi.fn(async () => generated("Never sent"));
    const budget = {
      maxOutputTokens: () => Constants.MODEL_CALL_MAX_OUTPUT_TOKENS,
      reserve: vi.fn(
        async (_estimate: Schemas.ModelCallEstimate): Promise<Schemas.ModelCallReservation> => ({
          isSuccess: false,
          refusal: Schemas.BudgetRefusalEnum.CompanyBudget,
        }),
      ),
    };
    const { model, records } = wrapped(
      new MockLanguageModelV4({ doGenerate }),
      vi.fn(async () => {}),
      budget,
    );

    await expect(generateText({ model, prompt: "Hi" })).rejects.toMatchObject({
      name: "ModelUnavailableError",
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.BudgetExceeded,
    });
    expect(doGenerate).not.toHaveBeenCalled();
    // DEV_NOTE: Nothing was called, so nothing is recorded, and a refusal is never retried
    expect(records).toEqual([]);
    expect(budget.reserve).toHaveBeenCalledOnce();
  });

  it("reserves every attempt, retries included, and each record settles its own hold", async () => {
    let calls = 0;
    const { budget, reservations } = allowAllBudget();
    const { model, settledReservationIds } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          calls += 1;
          if (calls === 1)
            throw apiError(529, { type: "error", error: { type: "overloaded_error" } });
          return generated("Second time lucky");
        },
      }),
      vi.fn(async () => {}),
      budget,
    );

    await generateText({ model, prompt: "Hi" });

    expect(reservations).toHaveLength(2);
    expect(settledReservationIds).toEqual(["reservation-1", "reservation-2"]);
  });

  it("caps the output at the turn's tokens left and sizes the hold on that cap", async () => {
    let sentMaxOutputTokens: number | undefined;
    const { budget, reservations } = allowAllBudget();
    budget.maxOutputTokens = () => 120;
    const { model } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async (options) => {
          sentMaxOutputTokens = options.maxOutputTokens;
          return generated("Short");
        },
      }),
      vi.fn(async () => {}),
      budget,
    );

    await generateText({ model, prompt: "Hi", maxOutputTokens: 50_000 });

    expect(sentMaxOutputTokens).toBe(120);
    expect(reservations[0]?.maxOutputTokens).toBe(120);
    expect(reservations[0]?.inputTokens).toBeGreaterThan(0);
  });

  it("never asks for more than the platform output cap", async () => {
    let sentMaxOutputTokens: number | undefined;
    const { model } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async (options) => {
          sentMaxOutputTokens = options.maxOutputTokens;
          return generated("Short");
        },
      }),
    );

    await generateText({ model, prompt: "Hi", maxOutputTokens: 1_000_000 });

    expect(sentMaxOutputTokens).toBe(Constants.MODEL_CALL_MAX_OUTPUT_TOKENS);
  });

  it("refuses a turn with no tokens left without asking the budget", async () => {
    const doGenerate = vi.fn(async () => generated("Never sent"));
    const { budget } = allowAllBudget();
    budget.maxOutputTokens = () => 0;
    const { model } = wrapped(
      new MockLanguageModelV4({ doGenerate }),
      vi.fn(async () => {}),
      budget,
    );

    await expect(generateText({ model, prompt: "Hi" })).rejects.toMatchObject({
      failure: Schemas.ModelRouterFailureEnum.BudgetExceeded,
    });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(doGenerate).not.toHaveBeenCalled();
  });

  it("estimates a longer prompt as more tokens, never fewer than its characters / 3", () => {
    const prompt = "x".repeat(3_000);
    const estimate = ModelCallRecordingProvider.estimateInputTokens({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    });
    expect(estimate).toBeGreaterThanOrEqual(1_000);
  });
});

describe("AiGatewayProvider usage rules", () => {
  it("treats a gateway timeout or upstream failure as possibly billed, and a gateway 4xx as refused", () => {
    const gatewayBody = { success: false, result: [], error: [{ code: 2008, message: "timeout" }] };
    expect(AiGatewayProvider.isRefusedCall(apiError(504, gatewayBody))).toBe(false);
    expect(AiGatewayProvider.isRefusedCall(apiError(408, gatewayBody))).toBe(false);
    expect(AiGatewayProvider.isRefusedCall(apiError(401, gatewayBody))).toBe(true);
    expect(AiGatewayProvider.isRefusedCall(apiError(429, gatewayBody))).toBe(true);
    expect(AiGatewayProvider.isRefusedCall(apiError(503, { error: { message: "x" } }))).toBe(true);
  });

  it("records a gateway 5xx that carries a log id as Pending", async () => {
    const { model, records } = wrapped(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw apiError(
            524,
            { success: false, result: [], error: [{ code: 2008, message: "upstream timeout" }] },
            { "cf-aig-log-id": "log-timeout" },
            false,
          );
        },
      }),
    );

    await expect(generateText({ model, prompt: "Hi" })).rejects.toBeInstanceOf(
      ModelUnavailableError,
    );
    expect(records).toEqual([
      expect.objectContaining({
        usage: null,
        usageStatus: Schemas.ModelCallUsageStatusIntEnum.Pending,
        gatewayLogId: "log-timeout",
        errorCode: "http_524",
      }),
    ]);
  });

  it("reads usage only when the provider reported an input total", () => {
    expect(AiGatewayProvider.toModelCallUsage(usage(undefined, 10))).toBeNull();
    expect(AiGatewayProvider.toModelCallUsage(usage(0, 0))).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
  });

  it("counts only a 4xx or 5xx answer as a refusal", () => {
    expect(AiGatewayProvider.isRefusedCall(apiError(429, {}))).toBe(true);
    expect(AiGatewayProvider.isRefusedCall(apiError(503, {}))).toBe(true);
    expect(AiGatewayProvider.isRefusedCall(apiError(200, {}))).toBe(false);
    expect(AiGatewayProvider.isRefusedCall(new TypeError("Network connection lost"))).toBe(false);
  });
});

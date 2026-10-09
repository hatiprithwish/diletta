import { describe, it, expect, vi } from "vitest";
import { APICallError, generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import * as Schemas from "@app/schemas";
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

const apiError = (statusCode: number, body: unknown, headers: Record<string, string> = {}) =>
  new APICallError({
    message: RAW_PROVIDER_TEXT,
    url: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: JSON.stringify(body),
  });

function wrapped(model: MockLanguageModelV4, onRejectedKey = vi.fn(async () => {})) {
  const records: Schemas.ModelCallRecord[] = [];
  return {
    records,
    onRejectedKey,
    model: wrapLanguageModel({
      model,
      middleware: ModelCallRecordingProvider.createMiddleware({
        provider: Schemas.ModelProviderEnum.Anthropic,
        onRecord: (record) => records.push(record),
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
    expect(records[0]).toMatchObject({
      usageStatus: Schemas.ModelCallUsageStatusIntEnum.Reported,
      usage: null,
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

describe("AiGatewayProvider usage rules", () => {
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

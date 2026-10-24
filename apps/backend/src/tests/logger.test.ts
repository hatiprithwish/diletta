import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { APICallError, NoObjectGeneratedError } from "ai";
import type { LogRecord } from "@logtape/logtape";
import * as Schemas from "@app/schemas";
import { ModelUnavailableError } from "@/providers/modelCallRecording";
import { jsonConsoleFormatter, toLoggableError } from "@/providers/logger";

describe("toLoggableError", () => {
  it("logs a failed query as its SQL, pg code and names, never the bound values", () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "UNQ_x"'),
      {
        code: "23505",
        constraint: "UNQ_x",
        table: "company_connections",
        column: undefined,
        detail: "Key (jwt_issuer)=(https://secret-issuer.example.com) already exists.",
      },
    );
    const error = new DrizzleQueryError(
      'insert into "company_connections" ("auth_config") values ($1)',
      ['{"clientSecret":"s3cr3t"}', "Asha Rao"],
      pgError,
    );

    const logged = toLoggableError(error);
    expect(logged).toEqual({
      name: "DrizzleQueryError",
      query: 'insert into "company_connections" ("auth_config") values ($1)',
      cause: {
        code: "23505",
        constraint: "UNQ_x",
        table: "company_connections",
        column: undefined,
      },
    });
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("Asha Rao");
    expect(serialized).not.toContain("secret-issuer");
  });

  it("keeps only the name of a non-pg cause", () => {
    const error = new DrizzleQueryError("select 1", ["Asha Rao"], new TypeError("Asha Rao"));
    expect(toLoggableError(error)).toEqual({
      name: "DrizzleQueryError",
      query: "select 1",
      cause: { name: "TypeError" },
    });
  });

  it("keeps an error's name, message, stack and codes, never a payload, down its cause chain", () => {
    const providerError = new APICallError({
      message: "Overloaded",
      url: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
      requestBodyValues: { messages: [{ role: "user", content: "PROMPT-MARKER my SSN" }] },
      statusCode: 529,
      responseHeaders: { "x-secret": "HEADER-MARKER" },
      responseBody: "RESPONSE-MARKER",
      isRetryable: true,
    });
    const error = new ModelUnavailableError(
      Schemas.ModelRouterFailureEnum.ProviderError,
      providerError,
    );

    const logged = toLoggableError(error);
    expect(logged).toMatchObject({
      name: "ModelUnavailableError",
      message: Schemas.MODEL_UNAVAILABLE_MESSAGE,
      failure: Schemas.ModelRouterFailureEnum.ProviderError,
      cause: { name: "AI_APICallError", message: "Overloaded", statusCode: 529, isRetryable: true },
    });
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("PROMPT-MARKER");
    expect(serialized).not.toContain("HEADER-MARKER");
    expect(serialized).not.toContain("RESPONSE-MARKER");
  });

  it("drops the model's answer from a NoObjectGeneratedError", () => {
    const error = new NoObjectGeneratedError({
      message: "No object generated",
      text: "ANSWER-MARKER",
      response: { id: "r", timestamp: new Date(0), modelId: "m" },
      usage: {
        inputTokens: 1,
        inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokens: 1,
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
        totalTokens: 2,
      },
      finishReason: "stop",
    });
    expect(JSON.stringify(toLoggableError(error))).not.toContain("ANSWER-MARKER");
  });

  it("passes a value that isn't an Error through unchanged", () => {
    expect(toLoggableError("Transaction rolled back")).toBe("Transaction rolled back");
  });
});

describe("jsonConsoleFormatter", () => {
  const record = (properties: Record<string, unknown>, message = "Failed"): LogRecord => ({
    category: ["diletta", "Repo"],
    level: "error",
    message: [message],
    rawMessage: message,
    timestamp: 0,
    properties,
  });

  it("redacts an address next to an escaped character and keeps the record", () => {
    const [logged] = jsonConsoleFormatter(
      record({ metadata: { note: "line1\nuser@example.com", tab: "tab\tbob@x.io" } }, "é ana@x.io"),
    );
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toMatch(/@example\.com|bob@x\.io|ana@x\.io/);
    expect(logged).toMatchObject({ metadata: { note: expect.stringMatching(/^line1\n/) } });
  });

  it("reduces an Error a record carries, even one that never went through AppLogger", () => {
    const providerError = new APICallError({
      message: "Overloaded",
      url: "https://example.com",
      requestBodyValues: { prompt: "PROMPT-MARKER" },
      statusCode: 529,
    });
    const [logged] = jsonConsoleFormatter(record({ error: providerError }));
    expect(JSON.stringify(logged)).not.toContain("PROMPT-MARKER");
    expect(logged).toMatchObject({ error: { name: "AI_APICallError", statusCode: 529 } });
  });
});

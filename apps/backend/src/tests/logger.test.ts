import { describe, it, expect, vi, afterEach } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { APICallError, NoObjectGeneratedError } from "ai";
import { reset, type LogRecord } from "@logtape/logtape";
import type * as Sentry from "@sentry/cloudflare";
import * as Schemas from "@app/schemas";
import { ModelUnavailableError } from "@/providers/modelCallRecording";
import AppLogger, {
  configureLogger,
  jsonConsoleFormatter,
  toLoggableError,
} from "@/providers/logger";
import SentryProvider, { scrubSentryEvent, toSentryEvent } from "@/providers/sentry";

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

describe("Sentry (M6-6)", () => {
  const record = (overrides: Partial<LogRecord> = {}): LogRecord => ({
    category: ["diletta-worker", "Relay"],
    level: "error",
    message: ["Events rejected by the Queue"],
    rawMessage: "Events rejected by the Queue",
    timestamp: 1_700_000_000_000,
    properties: {
      category: Schemas.LogCategory.Relay,
      action: Schemas.LogAction.RelayEvents,
      metadata: { companyId: "42", outboxIds: ["7"] },
      error: { name: "Error", message: "Batch rejected", stack: "Error: Batch rejected\n    at x" },
      requestId: "req-1",
    },
    ...overrides,
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  it("builds one issue per category, action, message and company, carrying the record's metadata and error", () => {
    expect(toSentryEvent(record())).toEqual({
      level: "error",
      message: "Events rejected by the Queue",
      logger: "diletta-worker.Relay",
      timestamp: 1_700_000_000,
      fingerprint: ["Relay", "RelayEvents", "Events rejected by the Queue", "42"],
      tags: { category: "Relay", action: "RelayEvents", requestId: "req-1" },
      contexts: {
        log: {
          metadata: { companyId: "42", outboxIds: ["7"] },
          error: {
            name: "Error",
            message: "Batch rejected",
            stack: "Error: Batch rejected\n    at x",
          },
        },
      },
    });
  });

  it("leaves the company out of the fingerprint when the metadata names none", () => {
    const event = toSentryEvent(
      record({
        level: "fatal",
        properties: {
          category: Schemas.LogCategory.Cron,
          action: Schemas.LogAction.DispatchCron,
          metadata: { job: "OutboxSweep" },
        },
      }),
    );
    expect(event.level).toBe("fatal");
    expect(event.fingerprint).toEqual(["Cron", "DispatchCron", "Events rejected by the Queue"]);
    expect(event.tags).toEqual({ category: "Cron", action: "DispatchCron" });
  });

  it("sends only error records to Sentry, redacted like the console", async () => {
    const captured = vi
      .spyOn(SentryProvider, "captureLogEvent")
      .mockImplementation(() => undefined);
    await configureLogger();

    AppLogger.info({
      category: Schemas.LogCategory.Relay,
      action: Schemas.LogAction.RelayEvents,
      message: "Events published",
    });
    AppLogger.warn({
      category: Schemas.LogCategory.Budget,
      action: Schemas.LogAction.ReserveBudget,
      message: "Budget refused",
    });
    AppLogger.error({
      category: Schemas.LogCategory.Relay,
      action: Schemas.LogAction.RelayEvents,
      message: "Queue unavailable for asha@example.com",
      error: new APICallError({
        message: "Overloaded",
        url: "https://example.com",
        requestBodyValues: { prompt: "PROMPT-MARKER" },
        statusCode: 529,
      }),
      metadata: { companyId: "42", clerkId: "user_CLERK-MARKER", note: "bob@example.com" },
    });

    expect(captured).toHaveBeenCalledOnce();
    const [event] = captured.mock.calls[0] ?? [];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/asha@example\.com|bob@example\.com|CLERK-MARKER|PROMPT-MARKER/);
    expect(event).toMatchObject({
      level: "error",
      tags: { category: "Relay", action: "RelayEvents" },
      contexts: { log: { error: { name: "AI_APICallError", statusCode: 529 } } },
    });
    expect(event?.fingerprint?.[3]).toBe("42");
  });

  it("scrubs an uncaught error: no request, user or breadcrumbs, a query's values never sent", () => {
    const queryError = new DrizzleQueryError(
      'insert into "chatbot_users" ("host_user_id") values ($1)',
      ["Asha Rao"],
      new Error("boom"),
    );
    const event: Sentry.ErrorEvent = {
      type: undefined,
      message: "Failed for asha@example.com",
      request: { headers: { "sec-websocket-protocol": "jwt.TOKEN-MARKER" } },
      user: { email: "asha@example.com" },
      breadcrumbs: [{ message: "fetch https://host.example.com/users/42" }],
      extra: { body: "BODY-MARKER" },
      exception: { values: [{ type: "DrizzleQueryError", value: `${queryError.message}` }] },
    };

    const scrubbed = scrubSentryEvent(event, { originalException: queryError });
    expect(scrubbed.request).toBeUndefined();
    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.exception?.values?.[0]?.value).toBe(
      'Failed query: insert into "chatbot_users" ("host_user_id") values ($1)',
    );
    expect(JSON.stringify(scrubbed)).not.toMatch(/Asha Rao|asha@example\.com|MARKER/);
  });

  it("redacts addresses in any other uncaught error's text", () => {
    const scrubbed = scrubSentryEvent(
      { type: undefined, exception: { values: [{ type: "Error", value: "No user ana@x.io" }] } },
      { originalException: new Error("No user ana@x.io") },
    );
    expect(scrubbed.exception?.values?.[0]?.value).not.toContain("ana@x.io");
  });
});

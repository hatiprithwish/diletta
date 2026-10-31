import Constants from "@/config/Constants";
import {
  type LogRecord,
  configure,
  dispose,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  withContext,
} from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, EMAIL_ADDRESS_PATTERN, redactByField } from "@logtape/redaction";
import type { RedactionPattern } from "@logtape/redaction";
import { DrizzleQueryError } from "drizzle-orm";
import type * as Schemas from "@app/schemas";
import { AsyncLocalStorage } from "node:async_hooks";

// DEV_NOTE: How deep a cause chain is followed when an error is logged
const MAX_LOGGED_CAUSE_DEPTH = 5;

// DEV_NOTE: The fields an error keeps besides name, message and stack: codes and flags, never a payload
const LOGGED_ERROR_FIELDS = ["statusCode", "failure", "code", "isRetryable"] as const;

// DEV_NOTE: An error as it reaches the log. A DrizzleQueryError's message and stack carry every bound value of the
// failed query (names, config JSON, PII), and a pg error's message and detail can quote values too, so a query error is
// logged as its SQL text plus the pg error's code and object names only. Any other Error (and each cause in its chain)
// keeps only its name, message, stack and LOGGED_ERROR_FIELDS: its other own fields can hold a payload, such as an
// APICallError's requestBodyValues (the whole prompt, chat text included) and responseBody, or a
// NoObjectGeneratedError's text (the model's answer). A value that isn't an Error passes through unchanged.
export function toLoggableError(error: unknown, depth = 0): unknown {
  if (error instanceof DrizzleQueryError) {
    return { name: error.name, query: error.query, cause: describeQueryErrorCause(error.cause) };
  }
  if (!(error instanceof Error)) return error;
  const logged: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  for (const field of LOGGED_ERROR_FIELDS) {
    const value: unknown = (error as unknown as Record<string, unknown>)[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      logged[field] = value;
    }
  }
  if (error.cause !== undefined && depth < MAX_LOGGED_CAUSE_DEPTH) {
    logged.cause = toLoggableError(error.cause, depth + 1);
  }
  return logged;
}

function describeQueryErrorCause(cause: unknown) {
  if (typeof cause !== "object" || cause === null) return undefined;
  // DEV_NOTE: pg DatabaseError (SQLSTATE) or a socket error (ECONNRESET…): the code and names say enough
  if ("code" in cause && typeof cause.code === "string") {
    return {
      code: cause.code,
      constraint: "constraint" in cause ? cause.constraint : undefined,
      table: "table" in cause ? cause.table : undefined,
      column: "column" in cause ? cause.column : undefined,
    };
  }
  return cause instanceof Error ? { name: cause.name } : undefined;
}

const REDACTED_PATTERNS: readonly RedactionPattern[] = [EMAIL_ADDRESS_PATTERN];

function redactText(text: string): string {
  let redacted = text;
  for (const { pattern, replacement } of REDACTED_PATTERNS) {
    // DEV_NOTE: Narrowed apart: String.replace has no overload for the string-or-function union
    redacted =
      typeof replacement === "string"
        ? redacted.replace(pattern, replacement)
        : redacted.replace(pattern, replacement);
  }
  return redacted;
}

// DEV_NOTE: Every string in a value redacted, walking plain objects and arrays; an Error is first reduced by
// toLoggableError (so a library's own record, which never went through AppLogger, can't log a payload either)
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth > MAX_LOGGED_CAUSE_DEPTH * 2 || typeof value !== "object" || value === null) {
    return value;
  }
  if (value instanceof Error) return redactValue(toLoggableError(value), depth + 1);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactValue(item, depth + 1)]),
  );
}

// DEV_NOTE: Workers Logs indexes the fields of a logged object, so every record goes out as one JSON object
// (`@timestamp`, `level`, `message`, `logger`, then category, action, metadata, error and requestId at the top level).
// The record's message and properties are redacted before the JSON Lines formatter serializes them: redacting the
// serialized line instead would eat the letter of an escape (`\n`, `\t`, `\uXXXX`) next to an address and break the
// JSON. The line is parsed back so the console gets an object, not a string.
const jsonLinesFormatter = getJsonLinesFormatter({ categorySeparator: ".", properties: "flatten" });

export function redactRecord(record: LogRecord): LogRecord {
  return {
    ...record,
    message: record.message.map((part) => redactValue(part)),
    rawMessage:
      typeof record.rawMessage === "string" ? redactText(record.rawMessage) : record.rawMessage,
    properties: redactValue(record.properties) as Record<string, unknown>,
  };
}

export function jsonConsoleFormatter(record: LogRecord): readonly unknown[] {
  return [JSON.parse(jsonLinesFormatter(redactRecord(record)))];
}

export async function configureLogger(): Promise<void> {
  const consoleSink = redactByField(getConsoleSink({ formatter: jsonConsoleFormatter }), [
    ...Constants.APP_REDACT_FIELDS,
    ...DEFAULT_REDACT_FIELDS,
  ]);

  await configure({
    sinks: { console: consoleSink },
    contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
    loggers: [
      {
        // DEV_NOTE: category for internal logtape/library metadata logs.
        category: ["logtape", "meta"],
        sinks: ["console"],
        lowestLevel: "warning",
      },
      // DEV_NOTE: category for application logs.
      {
        category: [Constants.APP_NAME],
        sinks: ["console"],
        lowestLevel: "info",
      },
    ],
  });
}

// DEV_NOTE: Expose dispose function to flush logs before worker termination.
export { dispose as disposeLogger };

// DEV_NOTE: Helper function to run a block of code within a request context (e.g. for correlating logs with a request ID).
export function withRequestContext<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  return withContext({ requestId }, fn);
}

export default class AppLogger {
  private static get(category: Schemas.LogCategory) {
    return getLogger([Constants.APP_NAME, category]);
  }

  static info(params: {
    category: Schemas.LogCategory;
    action: Schemas.LogAction;
    message: string;
    metadata?: unknown;
  }): void {
    AppLogger.get(params.category).info(params.message, {
      category: params.category,
      action: params.action,
      metadata: params.metadata,
    });
  }

  static warn(params: {
    category: Schemas.LogCategory;
    action: Schemas.LogAction;
    message: string;
    metadata?: unknown;
  }): void {
    AppLogger.get(params.category).warn(params.message, {
      category: params.category,
      action: params.action,
      metadata: params.metadata,
    });
  }

  static error(params: {
    category: Schemas.LogCategory;
    action: Schemas.LogAction;
    message: string;
    error?: unknown;
    metadata?: unknown;
  }): void {
    AppLogger.get(params.category).error(params.message, {
      category: params.category,
      action: params.action,
      metadata: params.metadata,
      error: toLoggableError(params.error),
    });
  }
}

import type { LogRecord } from "@logtape/logtape";
import { EMAIL_ADDRESS_PATTERN } from "@logtape/redaction";
import type { RedactionPattern } from "@logtape/redaction";
import { DrizzleQueryError } from "drizzle-orm";

// DEV_NOTE: What a log record, or a Sentry event, may carry (pure: no logger, no Sentry). The logger and SentryProvider
// both build on it, so neither imports the other's module for it, and a test that mocks the logger still gets it.

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

export function redactText(text: string): string {
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

// DEV_NOTE: The record's message and properties redacted, before any sink serializes or sends them
export function redactRecord(record: LogRecord): LogRecord {
  return {
    ...record,
    message: record.message.map((part) => redactValue(part)),
    rawMessage:
      typeof record.rawMessage === "string" ? redactText(record.rawMessage) : record.rawMessage,
    properties: redactValue(record.properties) as Record<string, unknown>,
  };
}

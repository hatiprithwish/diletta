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
import {
  DEFAULT_REDACT_FIELDS,
  EMAIL_ADDRESS_PATTERN,
  redactByField,
  redactByPattern,
} from "@logtape/redaction";
import { DrizzleQueryError } from "drizzle-orm";
import type * as Schemas from "@app/schemas";
import { AsyncLocalStorage } from "node:async_hooks";

// DEV_NOTE: A DrizzleQueryError's message and stack carry every bound value of the failed query (names, config
// JSON, PII), and a pg error's message and detail can quote values too. Field redaction can't see inside those
// strings, so a query error is logged as its SQL text plus the pg error's code and object names only.
export function toLoggableError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  return { name: error.name, query: error.query, cause: describeQueryErrorCause(error.cause) };
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

// DEV_NOTE: Workers Logs indexes the fields of a logged object, so every record goes out as one JSON object
// (`@timestamp`, `level`, `message`, `logger`, then category, action, metadata, error and requestId at the top level).
// The JSON Lines formatter serializes Errors (name, message, stack, cause) and runs before the email redaction, which
// only sees text; the line is parsed back so the console gets an object, not a string.
const redactedJsonLinesFormatter = redactByPattern(
  getJsonLinesFormatter({ categorySeparator: ".", properties: "flatten" }),
  [EMAIL_ADDRESS_PATTERN],
);

function jsonConsoleFormatter(record: LogRecord): readonly unknown[] {
  return [JSON.parse(redactedJsonLinesFormatter(record))];
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

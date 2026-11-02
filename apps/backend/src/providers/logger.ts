import Constants from "@/config/Constants";
import {
  type LogRecord,
  configure,
  dispose,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  withContext,
  withFilter,
} from "@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, redactByField } from "@logtape/redaction";
import type * as Schemas from "@app/schemas";
import { AsyncLocalStorage } from "node:async_hooks";
import { redactRecord, toLoggableError } from "@/providers/logRedaction";
import SentryProvider, { toSentryEvent } from "@/providers/sentry";

// DEV_NOTE: The redaction helpers live in logRedaction.ts (shared with SentryProvider); re-exported for their callers
export { redactRecord, redactValue, toLoggableError } from "@/providers/logRedaction";

// DEV_NOTE: Workers Logs indexes the fields of a logged object, so every record goes out as one JSON object
// (`@timestamp`, `level`, `message`, `logger`, then category, action, metadata, error and requestId at the top level).
// The record's message and properties are redacted before the JSON Lines formatter serializes them: redacting the
// serialized line instead would eat the letter of an escape (`\n`, `\t`, `\uXXXX`) next to an address and break the
// JSON. The line is parsed back so the console gets an object, not a string.
const jsonLinesFormatter = getJsonLinesFormatter({ categorySeparator: ".", properties: "flatten" });

export function jsonConsoleFormatter(record: LogRecord): readonly unknown[] {
  return [JSON.parse(jsonLinesFormatter(redactRecord(record)))];
}

function sentrySink(record: LogRecord): void {
  SentryProvider.captureLogEvent(toSentryEvent(redactRecord(record)));
}

export async function configureLogger(): Promise<void> {
  const redactedFields = [...Constants.APP_REDACT_FIELDS, ...DEFAULT_REDACT_FIELDS];
  const consoleSink = redactByField(
    getConsoleSink({ formatter: jsonConsoleFormatter }),
    redactedFields,
  );
  // DEV_NOTE: Errors (and fatals) only: Sentry is where alerts start, Workers Logs keeps every level
  const errorSentrySink = withFilter(redactByField(sentrySink, redactedFields), "error");

  await configure({
    sinks: { console: consoleSink, sentry: errorSentrySink },
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
        sinks: ["console", "sentry"],
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

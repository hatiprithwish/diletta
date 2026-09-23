import Constants from "@/config/Constants";
import {
  type LogRecord,
  defaultConsoleFormatter,
  configure,
  dispose,
  getConsoleSink,
  getLogger,
  withContext,
} from "@logtape/logtape";
import {
  DEFAULT_REDACT_FIELDS,
  EMAIL_ADDRESS_PATTERN,
  redactByField,
  redactByPattern,
} from "@logtape/redaction";
import type * as Schemas from "@app/schemas";
import { AsyncLocalStorage } from "node:async_hooks";

function consoleFormatterWithProps(record: LogRecord): readonly unknown[] {
  const base = defaultConsoleFormatter(record);
  const { action, metadata, error, category } = record.properties;
  const props: Record<string, unknown> = {};
  if (category !== undefined) props.category = category;
  if (action !== undefined) props.action = action;
  if (metadata !== undefined) props.metadata = metadata;
  if (error !== undefined) props.error = error;
  if (Object.keys(props).length === 0) return base;
  return [...base, "\n", props];
}

export async function configureLogger(): Promise<void> {
  const consoleSink = redactByField(
    getConsoleSink({
      formatter: redactByPattern(consoleFormatterWithProps, [EMAIL_ADDRESS_PATTERN]),
    }),
    [...Constants.APP_REDACT_FIELDS, ...DEFAULT_REDACT_FIELDS],
  );

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
    metadata?: any;
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
    metadata?: any;
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
    metadata?: any;
  }): void {
    AppLogger.get(params.category).error(params.message, {
      category: params.category,
      action: params.action,
      metadata: params.metadata,
      error: params.error,
    });
  }
}

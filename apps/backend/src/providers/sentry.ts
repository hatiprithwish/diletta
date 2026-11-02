import { env, waitUntil } from "cloudflare:workers";
import type { LogRecord } from "@logtape/logtape";
import * as Sentry from "@sentry/cloudflare";
import { DrizzleQueryError } from "drizzle-orm";
import Constants from "@/config/Constants";
import { redactText } from "@/providers/logRedaction";

type SentryTransport = NonNullable<Sentry.CloudflareOptions["transport"]>;
type SentryTransportOptions = Parameters<SentryTransport>[0];

// DEV_NOTE: An error record as a Sentry event (M6-6), built from the record after redactRecord, so Sentry holds what
// Workers Logs holds and nothing more. One Sentry issue per fingerprint: category, action and message, plus the
// company when the metadata names one, so a second company hitting the same alert opens its own issue (and its own
// Slack alert) instead of joining the first. The error, already reduced by toLoggableError, travels in the log
// context with its stack.
export function toSentryEvent(record: LogRecord): Sentry.Event {
  const { category, action, metadata, error, requestId } = record.properties;
  const message =
    typeof record.rawMessage === "string"
      ? record.rawMessage
      : record.message
          .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
          .join("");
  const companyId =
    typeof metadata === "object" && metadata !== null && "companyId" in metadata
      ? metadata.companyId
      : undefined;
  const tags: Record<string, string> = { category: String(category), action: String(action) };
  if (typeof requestId === "string") tags.requestId = requestId;

  return {
    level: record.level === "fatal" ? "fatal" : "error",
    message,
    logger: record.category.join("."),
    timestamp: record.timestamp / 1000,
    fingerprint: [
      String(category),
      String(action),
      message,
      ...(typeof companyId === "string" || typeof companyId === "number"
        ? [String(companyId)]
        : []),
    ],
    tags,
    contexts: { log: { metadata: metadata ?? null, error: error ?? null } },
  };
}

// DEV_NOTE: beforeSend for an uncaught error caught by withSentry (SentryProvider.workerOptions): the request, user,
// breadcrumbs and extras are dropped (a request's headers carry the widget's JWT), a failed query's message (it lists
// every bound value) becomes its SQL text, and any other exception text is redacted like a log string
export function scrubSentryEvent(
  event: Sentry.ErrorEvent,
  hint: Sentry.EventHint,
): Sentry.ErrorEvent {
  const {
    request: _request,
    user: _user,
    breadcrumbs: _breadcrumbs,
    extra: _extra,
    ...rest
  } = event;
  const original = hint.originalException;
  const scrubbed: Sentry.ErrorEvent = {
    ...rest,
    message: event.message === undefined ? undefined : redactText(event.message),
  };
  if (event.exception?.values) {
    const values = event.exception.values;
    scrubbed.exception = {
      ...event.exception,
      values: values.map((value, index) => ({
        ...value,
        value:
          original instanceof DrizzleQueryError && index === values.length - 1
            ? `Failed query: ${original.query}`
            : value.value === undefined
              ? undefined
              : redactText(value.value),
      })),
    };
  }
  return scrubbed;
}

// DEV_NOTE: Sentry (M6-6, docs/runbooks/observability.md). Two ways in, both off when SENTRY_DSN is empty (local dev
// and tests):
//   - Log records: every AppLogger error, wherever it runs (worker, cron, queue, both Durable Objects, the workflow),
//     is sent by the logger's Sentry sink through captureLogEvent, on one client per isolate. The event is built from
//     the record after its redaction (toSentryEvent), so it holds exactly what Workers Logs holds.
//   - Uncaught errors in the worker's own handlers (withSentry in index.ts, workerOptions): with no request data, user
//     or breadcrumbs, and the exception text scrubbed by scrubSentryEvent. Routes never get here: Hono's
//     onError logs them through AppLogger first.
// The Durable Objects and the workflow aren't wrapped with Sentry's instrumentation: on a DO it re-wraps every
// prototype method and disposes its client when any of them returns, which a Think agent calling its own methods
// would trip over. Their errors reach Sentry as log records.
// Alerts to the team channel are Sentry alert rules (Slack), configured in Sentry, never here.
export default class SentryProvider {
  private static client: Sentry.CloudflareClient | null = null;
  private static clientDsn = "";

  // DEV_NOTE: The options withSentry initializes its per-request client with
  static workerOptions(workerEnv: Env): Sentry.CloudflareOptions | undefined {
    if (!workerEnv.SENTRY_DSN) return undefined;
    return {
      ...SentryProvider.baseOptions(workerEnv),
      // DEV_NOTE: Only integrations that read nothing from a request, a fetch or the console: no RequestData (headers
      // carry the widget's JWT), Fetch (host API URLs), Console (breadcrumbs of every log line) or LinkedErrors (a
      // cause's message can quote a query's values)
      defaultIntegrations: [
        Sentry.dedupeIntegration(),
        Sentry.inboundFiltersIntegration(),
        Sentry.functionToStringIntegration(),
      ],
      beforeSend: scrubSentryEvent,
    };
  }

  // DEV_NOTE: Sends one event built from a log record. The send runs in waitUntil, so it never holds up the caller and
  // a failure only loses the event (Workers Logs still has the record). No client = Sentry off, nothing sent.
  static captureLogEvent(event: Sentry.Event): void {
    const client = SentryProvider.getClient();
    if (!client) return;
    client.captureEvent(event);
    waitUntil(client.flush(Constants.SENTRY_FLUSH_TIMEOUT_MS).then(() => undefined));
  }

  private static getClient(): Sentry.CloudflareClient | null {
    const dsn = env.SENTRY_DSN;
    if (!dsn) return null;
    if (SentryProvider.client && SentryProvider.clientDsn === dsn) return SentryProvider.client;

    const client = new Sentry.CloudflareClient({
      ...SentryProvider.baseOptions(env),
      integrations: [],
      transport: SentryProvider.fetchTransport,
      // DEV_NOTE: Log events carry no stack trace to parse: an error's stack travels in the event's log context
      stackParser: () => [],
    });
    client.init();
    SentryProvider.client = client;
    SentryProvider.clientDsn = dsn;
    return client;
  }

  private static baseOptions(workerEnv: Env) {
    return {
      dsn: workerEnv.SENTRY_DSN,
      environment: workerEnv.SENTRY_ENVIRONMENT || "local",
      sendDefaultPii: false,
      normalizeDepth: Constants.SENTRY_NORMALIZE_DEPTH,
    };
  }

  // DEV_NOTE: A plain fetch to the DSN's envelope endpoint, passing Sentry's rate-limit headers back so the client
  // backs off when told to
  private static fetchTransport(options: SentryTransportOptions) {
    return Sentry.createTransport(options, async (request) => {
      const response = await fetch(options.url, {
        method: "POST",
        headers: options.headers,
        body: request.body,
      });
      return {
        statusCode: response.status,
        headers: {
          "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
          "retry-after": response.headers.get("retry-after"),
        },
      };
    });
  }
}

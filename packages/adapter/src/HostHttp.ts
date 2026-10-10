import * as Schemas from "@app/schemas";

// DEV_NOTE: One HTTP attempt against the host. Pure transport: no retries, no idempotency rules (RestAdapter).

// DEV_NOTE: base_url + the rendered path (already encoded by renderToolOp). The result must stay on base_url's origin
// and under its path, and must not have been changed by URL normalisation (an encoded "." / ".." segment), so a
// placeholder value can never point a call (and its bearer token) anywhere else.
export function buildHostUrl(
  baseUrl: string,
  request: Schemas.RenderedToolRequest,
): Schemas.HostUrlResult {
  if (!URL.canParse(baseUrl)) return { isSuccess: false, message: "Invalid base URL" };
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.search || base.hash || base.username || base.password) {
    return { isSuccess: false, message: "Base URL must be https with no query or credentials" };
  }
  if (!request.path.startsWith("/") || request.path.startsWith("//")) {
    return { isSuccess: false, message: "Path must start with a single /" };
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const expectedPath = basePath + request.path;

  const url = new URL(base.origin);
  url.pathname = expectedPath;
  if (url.origin !== base.origin || url.pathname !== expectedPath) {
    return { isSuccess: false, message: "Path leaves the connection's base URL" };
  }
  for (const [key, value] of Object.entries(request.query)) url.searchParams.append(key, value);
  return { isSuccess: true, url };
}

// DEV_NOTE: Retry-After as delta seconds or an HTTP date, capped at HOST_CALL_RETRY_AFTER_MAX_MS; null if absent or
// unreadable
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), Schemas.HOST_CALL_RETRY_AFTER_MAX_MS);
}

// Reads at most HOST_RESPONSE_MAX_BYTES; null when the body is bigger
async function readCappedText(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > Schemas.HOST_RESPONSE_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string | null): { isReadable: boolean; body: unknown } {
  if (text === null) return { isReadable: false, body: undefined };
  if (text.trim() === "") return { isReadable: true, body: null };
  try {
    return { isReadable: true, body: JSON.parse(text) as unknown };
  } catch {
    return { isReadable: false, body: undefined };
  }
}

// DEV_NOTE: Redirects are never followed (redirect: "manual"): a 3xx comes back as an answer, so the auth headers only
// ever go to the connection's base_url. The timeout covers the body read too.
export async function sendHostAttempt(params: {
  fetch: typeof fetch;
  url: URL;
  request: Schemas.RenderedToolRequest;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Schemas.HostAttemptResult> {
  const { request } = params;
  const headers = new Headers({ ...params.headers, Accept: "application/json" });
  let body: string | undefined;
  if (request.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(request.body);
  }
  const timeout = AbortSignal.timeout(Schemas.HOST_CALL_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await params.fetch(params.url, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal,
    });
  } catch {
    return params.signal?.aborted
      ? { kind: Schemas.HostAttemptKindEnum.Aborted }
      : { kind: Schemas.HostAttemptKindEnum.NoAnswer };
  }

  // DEV_NOTE: The status is the host's answer even when its body then fails to arrive: a 2xx write landed
  let text: string | null;
  try {
    text = await readCappedText(response);
  } catch {
    text = null;
  }
  return {
    kind: Schemas.HostAttemptKindEnum.Answered,
    status: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
    ...parseJson(text),
  };
}

export const defaultHostRetryWait: Schemas.HostRetryWait = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

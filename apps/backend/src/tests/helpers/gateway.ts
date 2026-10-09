import { vi } from "vitest";

// DEV_NOTE: Shared by the model router and conversation suites. Stand-in for AI Gateway (model calls) and the Cloudflare API (gateway logs). respond builds the answer
// for each request to either host; every other URL goes to the real fetch untouched.
export interface MockedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}
export const mockedRequests: MockedRequest[] = [];
export const gatewayRequests = () =>
  mockedRequests.filter((mocked) => mocked.url.startsWith("https://gateway.ai.cloudflare.com/"));

// DEV_NOTE: Reads the fetch arguments directly rather than through new Request(input, init): workerd's Request
// rejects some init values real fetch accepts (redirect: "error")
export function mockCloudflare(respond: (request: MockedRequest) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const isMocked =
      url.startsWith("https://gateway.ai.cloudflare.com/") ||
      url.startsWith("https://api.cloudflare.com/");
    if (!isMocked) {
      return await realFetch(input, init);
    }
    const recorded: MockedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      signal: init?.signal ?? null,
    };
    mockedRequests.push(recorded);
    return await respond(recorded);
  });
}

export const anthropicMessage = (model: string) =>
  Response.json(
    {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Hello from the gateway" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 0,
      },
    },
    { headers: { "cf-aig-log-id": "log-generate" } },
  );

export const sse = (event: Record<string, unknown> & { type: string }) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export const anthropicStreamHead = (model: string) => [
  sse({
    type: "message_start",
    message: {
      id: "msg_stream",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 800, output_tokens: 1 },
    },
  }),
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Streamed" } }),
];

export const anthropicStreamTail = [
  sse({ type: "content_block_stop", index: 0 }),
  sse({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 50 },
  }),
  sse({ type: "message_stop" }),
];

export const STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cf-aig-log-id": "log-stream",
};

export const anthropicStream = (model: string) =>
  new Response([...anthropicStreamHead(model), ...anthropicStreamTail].join(""), {
    headers: STREAM_HEADERS,
  });

// DEV_NOTE: Sends the head of a stream, then either fails (connection lost) or stays open until the request is
// aborted, when it fails with the abort reason as a real fetch body does
export function anthropicBrokenStream(
  model: string,
  end: "error" | "hang",
  signal: AbortSignal | null = null,
) {
  const encoder = new TextEncoder();
  let hasSentHead = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!hasSentHead) {
        hasSentHead = true;
        controller.enqueue(encoder.encode(anthropicStreamHead(model).join("")));
        return;
      }
      if (end === "error") {
        controller.error(new TypeError("Network connection lost"));
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener("abort", () => resolve());
      });
      controller.error(signal?.reason);
    },
  });
  return new Response(body, { headers: STREAM_HEADERS });
}

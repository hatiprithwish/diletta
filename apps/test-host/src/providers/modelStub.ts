import * as Schemas from "@app/schemas";

// DEV_NOTE: The stub model's answers (M6-5, ADR 0005): the Anthropic Messages API as the platform's provider SDK reads
// it, with the same reply and the same usage every time. Pure: no clock, no storage; the route does the waiting.
export interface ModelStubFrame {
  // DEV_NOTE: How long to wait before this frame is sent
  delayMs: number;
  frame: string;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// The reply in TEST_HOST_MODEL_STUB_CHUNK_COUNT pieces that join back into the reply
function chunksOf(reply: string, count: number): string[] {
  const size = Math.ceil(reply.length / count);
  return Array.from({ length: count }, (_, index) =>
    reply.slice(index * size, (index + 1) * size),
  ).filter((chunk) => chunk.length > 0);
}

export default class ModelStubProvider {
  // The streaming answer: message_start, one text block in chunks, message_delta with the output tokens, message_stop
  static buildStream(model: string): ModelStubFrame[] {
    const chunks = chunksOf(
      Schemas.TEST_HOST_MODEL_STUB_REPLY,
      Schemas.TEST_HOST_MODEL_STUB_CHUNK_COUNT,
    );
    return [
      {
        delayMs: Schemas.TEST_HOST_MODEL_STUB_FIRST_TOKEN_DELAY_MS,
        frame: sse("message_start", {
          type: "message_start",
          message: {
            id: `msg_stub_${crypto.randomUUID().replaceAll("-", "")}`,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: Schemas.TEST_HOST_MODEL_STUB_INPUT_TOKENS, output_tokens: 1 },
          },
        }),
      },
      {
        delayMs: 0,
        frame: sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      },
      ...chunks.map((text) => ({
        delayMs: Schemas.TEST_HOST_MODEL_STUB_CHUNK_DELAY_MS,
        frame: sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        }),
      })),
      { delayMs: 0, frame: sse("content_block_stop", { type: "content_block_stop", index: 0 }) },
      {
        delayMs: 0,
        frame: sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: Schemas.TEST_HOST_MODEL_STUB_OUTPUT_TOKENS },
        }),
      },
      { delayMs: 0, frame: sse("message_stop", { type: "message_stop" }) },
    ];
  }

  // The same answer for a call that doesn't stream
  static buildMessage(model: string) {
    return {
      id: `msg_stub_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: Schemas.TEST_HOST_MODEL_STUB_REPLY }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: Schemas.TEST_HOST_MODEL_STUB_INPUT_TOKENS,
        output_tokens: Schemas.TEST_HOST_MODEL_STUB_OUTPUT_TOKENS,
      },
    };
  }

  // DEV_NOTE: Only a stub key is served: a real provider key sent here by mistake is refused, never answered
  static isStubKey(apiKey: string | undefined): boolean {
    return apiKey !== undefined && apiKey.startsWith(Schemas.LOAD_STUB_MODEL_KEY_PREFIX);
  }
}

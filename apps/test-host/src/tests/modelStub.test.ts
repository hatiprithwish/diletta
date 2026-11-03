import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "@/index";
import ModelStubProvider from "@/providers/modelStub";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The stub model (M6-5): the Anthropic Messages API as the platform's provider SDK reads it
const BASE = Schemas.TEST_HOST_MODEL_STUB_PATH;
const STUB_KEY = `${Schemas.LOAD_STUB_MODEL_KEY_PREFIX}${crypto.randomUUID()}`;
const MODEL = "claude-sonnet-5-5";

const post = (body: unknown, apiKey: string | null = STUB_KEY) =>
  app.request(
    `${BASE}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey === null ? {} : { "x-api-key": apiKey }),
      },
      body: JSON.stringify(body),
    },
    env,
  );

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      return {
        event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length) ?? "",
        data: JSON.parse(
          lines.find((line) => line.startsWith("data: "))?.slice("data: ".length) ?? "{}",
        ),
      };
    });
}

describe("stub model access", () => {
  it("serves only a stub key", async () => {
    for (const apiKey of [
      null,
      "",
      "sk-ant-real-key",
      Schemas.LOAD_STUB_MODEL_KEY_PREFIX.slice(0, -1),
    ]) {
      const refused = await post({ model: MODEL, stream: true }, apiKey);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({
        type: "error",
        error: { type: "authentication_error" },
      });
    }
    expect(ModelStubProvider.isStubKey(undefined)).toBe(false);
    expect(ModelStubProvider.isStubKey(STUB_KEY)).toBe(true);
  });

  it("lists models for the model key check, to a stub key only", async () => {
    const listed = await app.request(`${BASE}/models`, { headers: { "x-api-key": STUB_KEY } }, env);
    expect(listed.status).toBe(200);
    const refused = await app.request(
      `${BASE}/models`,
      { headers: { "x-api-key": "sk-ant-x" } },
      env,
    );
    expect(refused.status).toBe(401);
  });

  it("refuses a request that names no model", async () => {
    const response = await post({ stream: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ type: "error" });
  });
});

describe("stub model answers", () => {
  it("streams the canned reply as Anthropic events with fixed usage", async () => {
    const response = await post({ model: MODEL, stream: true, max_tokens: 1024, messages: [] });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const events = parseSse(await response.text());
    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      ...Array.from(
        { length: Schemas.TEST_HOST_MODEL_STUB_CHUNK_COUNT },
        () => "content_block_delta",
      ),
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]?.data).toMatchObject({
      message: {
        model: MODEL,
        role: "assistant",
        usage: { input_tokens: Schemas.TEST_HOST_MODEL_STUB_INPUT_TOKENS },
      },
    });
    const text = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.data.delta as { text: string }).text)
      .join("");
    expect(text).toBe(Schemas.TEST_HOST_MODEL_STUB_REPLY);
    expect(events.find((event) => event.event === "message_delta")?.data).toMatchObject({
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: Schemas.TEST_HOST_MODEL_STUB_OUTPUT_TOKENS },
    });
  });

  it("answers a call that doesn't stream with the same reply and usage", async () => {
    const response = await post({ model: MODEL, max_tokens: 1024, messages: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: "message",
      model: MODEL,
      content: [{ type: "text", text: Schemas.TEST_HOST_MODEL_STUB_REPLY }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: Schemas.TEST_HOST_MODEL_STUB_INPUT_TOKENS,
        output_tokens: Schemas.TEST_HOST_MODEL_STUB_OUTPUT_TOKENS,
      },
    });
  });

  it("waits for the first token like a model does, so concurrent chats overlap", async () => {
    const startedAt = Date.now();
    await (await post({ model: MODEL, stream: true })).text();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
      Schemas.TEST_HOST_MODEL_STUB_FIRST_TOKEN_DELAY_MS,
    );
  });
});

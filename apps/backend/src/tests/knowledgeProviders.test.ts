import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import * as Schemas from "@app/schemas";
import KnowledgeEmbedProvider from "@/providers/knowledgeEmbed";
import KnowledgeExtractProvider from "@/providers/knowledgeExtract";
import KnowledgeSyncWorkflowProvider from "@/providers/knowledgeSyncWorkflow";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: The real Workers AI and Workflows providers (M2-5) against fake bindings: what they send, how they read the
// answer, and every failure path. No test reaches Workers AI (remoteBindings: false).
function withAi(ai: object): Env {
  return { ...env, AI: ai as unknown as Ai };
}

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

function vector(): number[] {
  return Array.from({ length: Schemas.KNOWLEDGE_EMBEDDING_DIMENSIONS }, () => 0.5);
}

describe("KnowledgeExtractProvider", () => {
  it("reads text with its BOM or charset, falling back to UTF-8 on an unknown label", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect(KnowledgeExtractProvider.decodeText(utf16, null)).toBe("Hi");
    const utf8 = new TextEncoder().encode("Héllo");
    expect(KnowledgeExtractProvider.decodeText(utf8, "not-a-charset")).toBe("Héllo");
  });

  it("checks the magic bytes of binary uploads only", () => {
    const pdf = "application/pdf";
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(KnowledgeExtractProvider.matchesType(new TextEncoder().encode("%PDF-1.7"), pdf)).toBe(
      true,
    );
    expect(KnowledgeExtractProvider.matchesType(new TextEncoder().encode("hello"), pdf)).toBe(
      false,
    );
    expect(
      KnowledgeExtractProvider.matchesType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), docx),
    ).toBe(true);
    expect(
      KnowledgeExtractProvider.matchesType(new TextEncoder().encode("anything"), "text/plain"),
    ).toBe(true);
  });

  it("converts HTML through toMarkdown, named by its extension", async () => {
    const toMarkdown = vi.fn().mockResolvedValue({
      id: "1",
      name: "document.html",
      mimeType: "text/html",
      format: "markdown",
      tokens: 3,
      data: "# Hi",
    });
    const result = await KnowledgeExtractProvider.toText(withAi({ toMarkdown }), {
      bytes: bytes("<h1>Hi</h1>"),
      mime: "text/html",
      charset: null,
    });
    expect(result).toMatchObject({ isSuccess: true, text: "# Hi" });
    expect(toMarkdown.mock.calls[0]?.[0]?.name).toBe("document.html");
  });

  it("fails on a conversion error, a thrown call, or an unsupported type", async () => {
    const errored = await KnowledgeExtractProvider.toText(
      withAi({ toMarkdown: vi.fn().mockResolvedValue({ format: "error", error: "bad pdf" }) }),
      { bytes: bytes("%PDF-"), mime: "application/pdf", charset: null },
    );
    expect(errored.isSuccess).toBe(false);
    const thrown = await KnowledgeExtractProvider.toText(
      withAi({ toMarkdown: vi.fn().mockRejectedValue(new Error("down")) }),
      { bytes: bytes("<p>x</p>"), mime: "text/html", charset: null },
    );
    expect(thrown.isSuccess).toBe(false);
    const toMarkdown = vi.fn();
    const image = await KnowledgeExtractProvider.toText(withAi({ toMarkdown }), {
      bytes: new Uint8Array([1]),
      mime: "image/png",
      charset: null,
    });
    expect(image.isSuccess).toBe(false);
    expect(toMarkdown).not.toHaveBeenCalled();
  });
});

describe("KnowledgeEmbedProvider", () => {
  it("embeds in batches through the gateway and reports one call per batch", async () => {
    let logId = 0;
    const ai = {
      aiGatewayLogId: null as string | null,
      run: vi.fn(async (_model: string, inputs: { text: string[] }) => {
        ai.aiGatewayLogId = `log-${++logId}`;
        return { shape: [inputs.text.length, 1024], data: inputs.text.map(() => vector()) };
      }),
    };
    const texts = Array.from({ length: 51 }, (_, i) => `text ${i}`);

    const result = await KnowledgeEmbedProvider.embed(withAi(ai), {
      companyPublicId: "co_1",
      taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
      texts,
    });

    expect(result.isSuccess).toBe(true);
    expect(result.embeddings).toHaveLength(51);
    expect(ai.run).toHaveBeenCalledTimes(2);
    const [model, inputs, options] = ai.run.mock.calls[0] as unknown as [
      string,
      { text: string[]; truncate_inputs: boolean },
      { gateway: { id: string; metadata: Record<string, string> } },
    ];
    expect(model).toBe(Schemas.KNOWLEDGE_EMBEDDING_MODEL);
    expect(inputs.text).toHaveLength(50);
    expect(inputs.truncate_inputs).toBe(true);
    expect(options.gateway.id).toBe(env.AI_GATEWAY_NAME);
    expect(options.gateway.metadata).toEqual({
      company_id: "co_1",
      task_type: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
    });
    expect(result.calls?.map((call) => call.gatewayLogId)).toEqual(["log-1", "log-2"]);
    expect(result.calls?.[0]?.inputTokens).toBe(
      texts.slice(0, 50).reduce((n, t) => n + t.length + 2, 0),
    );
  });

  it("refuses a response of the wrong shape, keeping the call for its row", async () => {
    const ai = {
      aiGatewayLogId: "log-1",
      run: vi.fn().mockResolvedValue({ data: [[1, 2, 3]] }),
    };
    const result = await KnowledgeEmbedProvider.embed(withAi(ai), {
      companyPublicId: "co_1",
      taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
      texts: ["a"],
    });
    expect(result.isSuccess).toBe(false);
    expect(result.calls).toHaveLength(1);
  });

  it("records a failed call with no stale gateway log id", async () => {
    const ai = { aiGatewayLogId: "log-old", run: vi.fn().mockRejectedValue(new Error("busy")) };
    const result = await KnowledgeEmbedProvider.embed(withAi(ai), {
      companyPublicId: "co_1",
      taskType: Schemas.ModelTaskTypeEnum.KnowledgeEmbed,
      texts: ["a", "b"],
    });
    expect(result.isSuccess).toBe(false);
    expect(result.calls).toEqual([
      {
        inputTokens: 6,
        latencyMs: expect.any(Number),
        gatewayLogId: null,
        errorCode: "embed_failed",
      },
    ]);
  });
});

describe("KnowledgeSyncWorkflowProvider", () => {
  const params = { companyId: "1", knowledgeSourcePublicId: "src", syncRunId: "ks-src-01ABC" };

  it("creates the instance under the claimed run id", async () => {
    const create = vi.fn().mockResolvedValue({ id: params.syncRunId });
    const started = await KnowledgeSyncWorkflowProvider.start(
      { ...env, KNOWLEDGE_SYNC_WORKFLOW: { create } as unknown as Env["KNOWLEDGE_SYNC_WORKFLOW"] },
      params,
    );
    expect(started.isSuccess).toBe(true);
    expect(create).toHaveBeenCalledWith({ id: params.syncRunId, params });
  });

  it("answers a failure instead of throwing", async () => {
    const create = vi.fn().mockRejectedValue(new Error("rate limited"));
    const started = await KnowledgeSyncWorkflowProvider.start(
      { ...env, KNOWLEDGE_SYNC_WORKFLOW: { create } as unknown as Env["KNOWLEDGE_SYNC_WORKFLOW"] },
      params,
    );
    expect(started.isSuccess).toBe(false);
  });
});

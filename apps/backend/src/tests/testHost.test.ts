import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Schemas from "@app/schemas";
import WidgetJwtProvider from "@/providers/widgetJwt";
import { seedJwks } from "@/tests/helpers/widgetJwt";
import {
  mintTestHostTokens,
  newTestHostWorkspace,
  render,
  resetTestHost,
  setTestHostFaults,
  testHostAdapter,
  testHostFetch,
  testHostIssuer,
  testHostTool,
} from "@/tests/helpers/testHost";

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: The test host (M3-3) as the platform sees it: its companion JWT passes widget auth's token checks, and its
// tool definitions run through the real adapter (@app/adapter) against the real test host (auxiliary worker, its own
// Durable Object), covering each idempotency mode and the read-after outcomes the action engine (M3-4, M3-6) builds on.
// No database: nothing here touches Neon.
const { Native, Emulated, None } = Schemas.ToolDefinitionIdempotencyModeIntEnum;
const { Succeeded, AlreadyApplied, Unknown, TokenRejected, TokenNeeded } =
  Schemas.HostCallOutcomeEnum;

let workspace = "";
let hostToken: string | null = null;
let adapter: Schemas.HostAdapter;

beforeEach(async () => {
  workspace = newTestHostWorkspace();
  hostToken = (await mintTestHostTokens(workspace)).hostToken;
  await resetTestHost(hostToken);
  adapter = testHostAdapter(() => hostToken);
});

async function readAlpha(): Promise<unknown> {
  const response = await adapter.readback({
    request: render(testHostTool("update_record").ops.readbackOp!, {
      args: { recordId: "rec_alpha" },
    }),
  });
  return response.body;
}

// The update_record write as the action engine will send it: read-before, then the call with the Emulated check
async function commitUpdate(
  args: Record<string, unknown>,
  mode: Schemas.ToolDefinitionIdempotencyModeIntEnum = Emulated,
) {
  const tool = testHostTool("update_record");
  const readbackOp = tool.ops.readbackOp!;
  const before = await readAlpha();
  const response = await adapter.execute({
    risk: Schemas.ToolDefinitionRiskIntEnum.Write,
    request: render(tool.ops.callOp, { args }),
    idempotencyMode: mode,
    idempotencyKey: `cr_${crypto.randomUUID()}:commit`,
    appliedCheck:
      mode === Emulated
        ? {
            request: render(readbackOp, { args }),
            expectations: Schemas.getCommitCheckExpectations(readbackOp, args, before),
          }
        : null,
    isResume: false,
  });
  return { response, before, readbackOp };
}

describe("test host identity", () => {
  it("signs a companion JWT that passes widget auth's signature and claim checks", async () => {
    const { companionJwt } = await mintTestHostTokens(workspace, { name: "Ada" });
    const jwksResponse = await testHostFetch(`${testHostIssuer}/.well-known/jwks.json`);
    const jwks = Schemas.ZJwks.parse(await jwksResponse.json());
    await seedJwks(testHostIssuer, jwks.keys);

    const decoded = WidgetJwtProvider.decode(companionJwt);
    expect(decoded.isSuccess).toBe(true);
    const verified = await WidgetJwtProvider.verifySignature(env, testHostIssuer, decoded.jwt!);
    expect(verified.isSuccess).toBe(true);
    expect(WidgetJwtProvider.checkClaims(decoded.jwt!.claims).isSuccess).toBe(true);
  });

  it("is TokenRejected for an expired host token and TokenNeeded for none, sending nothing", async () => {
    const read = {
      request: render(testHostTool("get_record").ops.callOp, { args: { recordId: "rec_alpha" } }),
    };
    hostToken = (await mintTestHostTokens(workspace, { expiresInSeconds: -5 })).hostToken;
    expect((await adapter.readback(read)).outcome).toBe(TokenRejected);

    hostToken = null;
    const response = await adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Write,
      request: render(testHostTool("update_record").ops.callOp, {
        args: { recordId: "rec_alpha", amount: 1 },
      }),
      idempotencyMode: Native,
      idempotencyKey: "cr_none:commit",
      appliedCheck: null,
      isResume: false,
    });
    expect(response).toMatchObject({ outcome: TokenNeeded, mayHaveLanded: false });
  });
});

describe("test host tools through the adapter", () => {
  it("reads: get_record and list_records", async () => {
    const get = await adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Read,
      request: render(testHostTool("get_record").ops.callOp, { args: { recordId: "rec_bravo" } }),
    });
    expect(get).toMatchObject({ outcome: Succeeded, body: { data: { id: "rec_bravo" } } });

    const list = await adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Read,
      request: render(testHostTool("list_records").ops.callOp, { args: { status: "archived" } }),
    });
    expect(Schemas.ZTestHostRecordListResponse.parse(list.body).data.map(({ id }) => id)).toEqual([
      "rec_charlie",
    ]);
  });

  it("Native: a create whose answer is lost is resent with its key and lands once", async () => {
    await setTestHostFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 503,
        isApplied: true,
        method: Schemas.ToolOpMethodEnum.Post,
      },
    ]);
    const tool = testHostTool("create_record");
    const args = { name: "Delta", email: "ops@delta.example", amount: 5 };
    const response = await adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Write,
      request: render(tool.ops.callOp, { args }),
      idempotencyMode: Native,
      idempotencyKey: "cr_create:commit",
      appliedCheck: null,
      isResume: false,
    });
    expect(response).toMatchObject({ outcome: Succeeded, attempts: 2, mayHaveLanded: true });

    const list = await adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Read,
      request: render(testHostTool("list_records").ops.callOp, { args: {} }),
    });
    const created = Schemas.ZTestHostRecordListResponse.parse(list.body).data.filter(
      (record) => record.name === "Delta",
    );
    expect(created).toHaveLength(1);

    // Read-after through {result.*}: verified
    const readback = await adapter.readback({
      request: render(tool.ops.readbackOp!, { args, result: response.body }),
    });
    expect(
      Schemas.compareReadback(
        Schemas.getCommitExpectations(tool.ops.readbackOp!, args),
        readback.body,
      ).isMatch,
    ).toBe(true);
  });

  it("Emulated: an update whose answer is lost is found by readback and never resent", async () => {
    await setTestHostFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 503,
        isApplied: true,
        method: Schemas.ToolOpMethodEnum.Patch,
      },
    ]);
    const { response } = await commitUpdate({ recordId: "rec_alpha", amount: 12.5 });
    expect(response).toMatchObject({ outcome: AlreadyApplied, attempts: 1 });
    expect(Schemas.ZTestHostRecordResponse.parse(await readAlpha()).data.amount).toBe(12.5);
  });

  it("Emulated: refused before it applied, it is resent and lands", async () => {
    await setTestHostFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 503,
        isApplied: false,
        method: Schemas.ToolOpMethodEnum.Patch,
      },
    ]);
    const { response } = await commitUpdate({ recordId: "rec_alpha", amount: 7 });
    expect(response).toMatchObject({ outcome: Succeeded, attempts: 2 });
  });

  it("Emulated: a value the host stores in another form is Unknown, never resent", async () => {
    await setTestHostFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 503,
        isApplied: true,
        method: Schemas.ToolOpMethodEnum.Patch,
      },
    ]);
    const { response } = await commitUpdate({ recordId: "rec_alpha", email: "New@Alpha.Example" });
    expect(response).toMatchObject({ outcome: Unknown, attempts: 1, mayHaveLanded: true });
  });

  it("None: a lost answer is Unknown and the write isn't resent", async () => {
    await setTestHostFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 502,
        isApplied: true,
        method: Schemas.ToolOpMethodEnum.Patch,
      },
    ]);
    const { response } = await commitUpdate({ recordId: "rec_alpha", amount: 3 }, None);
    expect(response).toMatchObject({ outcome: Unknown, attempts: 1, mayHaveLanded: true });
  });

  it("a 429 with Retry-After is resent in every mode", async () => {
    await setTestHostFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 429,
        isApplied: false,
        retryAfterSeconds: 1,
        method: Schemas.ToolOpMethodEnum.Patch,
      },
    ]);
    const { response } = await commitUpdate({ recordId: "rec_alpha", amount: 4 }, None);
    expect(response).toMatchObject({ outcome: Succeeded, attempts: 2 });
  });

  it("read-after: verified, and a concurrent edit is a mismatch", async () => {
    const args = { recordId: "rec_alpha", amount: 50 };
    const verified = await commitUpdate(args);
    expect(verified.response.outcome).toBe(Succeeded);
    expect(
      Schemas.compareReadback(
        Schemas.getCommitExpectations(verified.readbackOp, args),
        await readAlpha(),
      ).isMatch,
    ).toBe(true);

    await setTestHostFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Overwrite,
        fields: { amount: 51 },
        method: Schemas.ToolOpMethodEnum.Patch,
      },
    ]);
    const mismatched = await commitUpdate({ recordId: "rec_alpha", amount: 60 });
    expect(mismatched.response.outcome).toBe(Succeeded);
    expect(
      Schemas.compareReadback(
        Schemas.getCommitExpectations(mismatched.readbackOp, { recordId: "rec_alpha", amount: 60 }),
        await readAlpha(),
      ).isMatch,
    ).toBe(false);
  });

  it("undo: an update's inverse puts the read-before values back", async () => {
    const args = { recordId: "rec_alpha", amount: 1, status: "archived" };
    const { response, before, readbackOp } = await commitUpdate(args);
    expect(response.outcome).toBe(Succeeded);

    const tool = testHostTool("update_record");
    const undo = await adapter.undo({
      request: render(tool.ops.inverseOp!, { args, before, result: response.body }),
      idempotencyMode: Emulated,
      idempotencyKey: "cr_undo:undo",
      appliedCheck: {
        request: render(readbackOp, { args }),
        expectations: Schemas.getUndoCheckExpectations(readbackOp, args, before),
      },
      isResume: false,
    });
    expect(undo.outcome).toBe(Succeeded);
    expect(
      Schemas.compareReadback(
        Schemas.getUndoExpectations(readbackOp, args, before),
        await readAlpha(),
      ).isMatch,
    ).toBe(true);
  });

  it("undo: a deleted record is put back under its id", async () => {
    const tool = testHostTool("delete_record");
    const args = { recordId: "rec_bravo" };
    const before = (await adapter.readback({ request: render(tool.ops.readbackOp!, { args }) }))
      .body;

    const removed = await adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Destructive,
      request: render(tool.ops.callOp, { args }),
      idempotencyMode: Native,
      idempotencyKey: "cr_delete:commit",
      appliedCheck: null,
      isResume: false,
    });
    expect(removed).toMatchObject({ outcome: Succeeded, httpStatus: 204 });

    const undo = await adapter.undo({
      request: render(tool.ops.inverseOp!, { args, before }),
      idempotencyMode: Native,
      idempotencyKey: "cr_delete:undo",
      appliedCheck: null,
      isResume: false,
    });
    expect(undo).toMatchObject({ outcome: Succeeded, httpStatus: 201 });
    const restored = await adapter.readback({ request: render(tool.ops.readbackOp!, { args }) });
    expect(restored.body).toEqual(before);
  });
});

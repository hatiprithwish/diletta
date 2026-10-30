import { RestAdapter } from "@app/adapter";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The Conversation DO's host calls (M3-4), the backend's one caller of @app/adapter (pattern rule 3.30):
// every request is rendered by Schemas.renderToolOp from args already checked against the tool's input_schema, and
// the bearer token is read from the DO's memory per attempt (getHostToken), never stored here. Never throws: a request
// that can't be rendered or an adapter that can't be built is a Failed outcome with nothing sent. Messages never hold
// a token, args or a host body.
//   read: a read tool's call_op.
//   readBefore: a write's readback_op with the args, before the user decides (no {result.*}: a create has none).
//   commit: a write's call_op with the args the user approved, under the change request's key. An Emulated tool proves
//     a lost answer by reading back (appliedCheck: the args against the read-before values); isResume when an earlier
//     attempt may have reached the host.
//   readAfter (M3-6): a write's readback_op after its commit (args + the commit's result) or after its undo.
//   undo (M3-6): a write's inverse_op (args + read-before + result) under the change request's undo key. An Emulated
//     tool proves a lost answer by reading back (the read-before values against the args, the commit's check swapped).
//   reset (M5-2): an eval run's staging connection reset_op, once after the run. Eval readbacks use readAfter.
export default class HostToolCallProvider {
  static async read(params: {
    tool: Schemas.RuntimeTool;
    args: Record<string, unknown>;
    getHostToken: Schemas.HostTokenSource;
    signal?: AbortSignal;
  }): Promise<Schemas.HostCallResponse> {
    // DEV_NOTE: Sent as a read (retried freely), so only a read tool's call_op may go this way
    if (params.tool.risk !== Schemas.ToolDefinitionRiskIntEnum.Read) {
      return HostToolCallProvider.notSent("Not a read tool");
    }
    const adapter = HostToolCallProvider.adapterFor(params.tool, params.getHostToken);
    const rendered = Schemas.renderToolOp(params.tool.ops.callOp, { args: params.args });
    if (!adapter.adapter || !rendered.request) {
      return HostToolCallProvider.notSent(adapter.message ?? rendered.message);
    }
    return await adapter.adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Read,
      request: rendered.request,
      signal: params.signal,
    });
  }

  static async readBefore(params: {
    tool: Schemas.RuntimeTool;
    args: Record<string, unknown>;
    getHostToken: Schemas.HostTokenSource;
    signal?: AbortSignal;
  }): Promise<Schemas.HostCallResponse> {
    const { readbackOp } = params.tool.ops;
    if (!readbackOp) return HostToolCallProvider.notSent("Tool has no readback op");
    const adapter = HostToolCallProvider.adapterFor(params.tool, params.getHostToken);
    const rendered = Schemas.renderToolOp(readbackOp, { args: params.args });
    if (!adapter.adapter || !rendered.request) {
      return HostToolCallProvider.notSent(adapter.message ?? rendered.message);
    }
    return await adapter.adapter.readback({ request: rendered.request, signal: params.signal });
  }

  static async commit(params: {
    plan: Schemas.CommitPlan;
    getHostToken: Schemas.HostTokenSource;
    signal?: AbortSignal;
  }): Promise<Schemas.HostCallResponse> {
    const { tool, payload, idempotencyKey, isResume } = params.plan;
    if (tool.risk === Schemas.ToolDefinitionRiskIntEnum.Read || !tool.ops.readbackOp) {
      return HostToolCallProvider.notSent("Not a write tool");
    }
    const adapter = HostToolCallProvider.adapterFor(tool, params.getHostToken);
    const rendered = Schemas.renderToolOp(tool.ops.callOp, { args: payload.args });
    if (!adapter.adapter || !rendered.request) {
      return HostToolCallProvider.notSent(adapter.message ?? rendered.message);
    }

    let appliedCheck: Schemas.HostAppliedCheck | null = null;
    if (tool.idempotencyMode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated) {
      const readback = Schemas.renderToolOp(tool.ops.readbackOp, { args: payload.args });
      if (!readback.request) return HostToolCallProvider.notSent(readback.message);
      appliedCheck = {
        request: readback.request,
        expectations: Schemas.getCommitCheckExpectations(
          tool.ops.readbackOp,
          payload.args,
          payload.before,
        ),
      };
    }

    return await adapter.adapter.execute({
      risk: tool.risk,
      request: rendered.request,
      idempotencyMode: tool.idempotencyMode,
      idempotencyKey,
      appliedCheck,
      isResume,
      signal: params.signal,
    });
  }

  static async readAfter(params: {
    plan: Pick<Schemas.FollowUpPlan, "tool" | "payload">;
    getHostToken: Schemas.HostTokenSource;
    signal?: AbortSignal;
  }): Promise<Schemas.HostCallResponse> {
    const { tool, payload } = params.plan;
    const { readbackOp } = tool.ops;
    if (!readbackOp) return HostToolCallProvider.notSent("Tool has no readback op");
    const adapter = HostToolCallProvider.adapterFor(tool, params.getHostToken);
    const rendered = Schemas.renderToolOp(readbackOp, {
      args: payload.args,
      result: payload.result ?? undefined,
    });
    if (!adapter.adapter || !rendered.request) {
      return HostToolCallProvider.notSent(adapter.message ?? rendered.message);
    }
    return await adapter.adapter.readback({ request: rendered.request, signal: params.signal });
  }

  static async undo(params: {
    plan: Schemas.FollowUpPlan;
    getHostToken: Schemas.HostTokenSource;
    signal?: AbortSignal;
  }): Promise<Schemas.HostCallResponse> {
    const { tool, payload, idempotencyKey, isResume } = params.plan;
    const { readbackOp, inverseOp } = tool.ops;
    if (tool.risk === Schemas.ToolDefinitionRiskIntEnum.Read || !readbackOp || !inverseOp) {
      return HostToolCallProvider.notSent("Tool can't be undone");
    }
    if (!idempotencyKey) return HostToolCallProvider.notSent("Undo has no key");
    const adapter = HostToolCallProvider.adapterFor(tool, params.getHostToken);
    const rendered = Schemas.renderToolOp(inverseOp, {
      args: payload.args,
      before: payload.before ?? undefined,
      result: payload.result ?? undefined,
    });
    if (!adapter.adapter || !rendered.request) {
      return HostToolCallProvider.notSent(adapter.message ?? rendered.message);
    }

    let appliedCheck: Schemas.HostAppliedCheck | null = null;
    if (tool.idempotencyMode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated) {
      const readback = Schemas.renderToolOp(readbackOp, { args: payload.args });
      if (!readback.request) return HostToolCallProvider.notSent(readback.message);
      appliedCheck = {
        request: readback.request,
        expectations: Schemas.getUndoCheckExpectations(readbackOp, payload.args, payload.before),
      };
    }

    return await adapter.adapter.undo({
      request: rendered.request,
      idempotencyMode: tool.idempotencyMode,
      idempotencyKey,
      appliedCheck,
      isResume,
      signal: params.signal,
    });
  }

  // DEV_NOTE: An eval run's reset (M5-2): the staging connection's reset_op (no placeholders), sent once per run after
  // its last attempt as the host test user, under the run's key so a retried reset is the same request. Sent as a Native write:
  // the host's Idempotency-Key handling makes a resend harmless.
  static async reset(params: {
    connection: Schemas.HostConnection;
    op: Schemas.ConnectionResetOp;
    idempotencyKey: string;
    getHostToken: Schemas.HostTokenSource;
    signal?: AbortSignal;
  }): Promise<Schemas.HostCallResponse> {
    const adapter = RestAdapter.create({
      connection: params.connection,
      getHostToken: params.getHostToken,
    });
    const rendered = Schemas.renderToolOp(params.op, { args: {} });
    if (!adapter.adapter || !rendered.request) {
      return HostToolCallProvider.notSent(adapter.message ?? rendered.message);
    }
    return await adapter.adapter.execute({
      risk: Schemas.ToolDefinitionRiskIntEnum.Write,
      request: rendered.request,
      idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.Native,
      idempotencyKey: params.idempotencyKey,
      appliedCheck: null,
      isResume: false,
      signal: params.signal,
    });
  }

  private static adapterFor(
    tool: Schemas.RuntimeTool,
    getHostToken: Schemas.HostTokenSource,
  ): Schemas.CreateHostAdapterResponse {
    return RestAdapter.create({ connection: tool.connection, getHostToken });
  }

  private static notSent(message: string | undefined): Schemas.HostCallResponse {
    return {
      isSuccess: false,
      message: message ?? "Host call not made",
      outcome: Schemas.HostCallOutcomeEnum.Failed,
      attempts: 0,
      mayHaveLanded: false,
    };
  }
}

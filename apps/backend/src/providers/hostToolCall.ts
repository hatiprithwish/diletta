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
export default class HostToolCallProvider {
  static async read(params: {
    tool: Schemas.RuntimeTool;
    args: Record<string, unknown>;
    getHostToken: Schemas.HostTokenSource;
    signal?: AbortSignal;
  }): Promise<Schemas.HostCallResponse> {
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

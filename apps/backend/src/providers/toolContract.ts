import * as Schemas from "@app/schemas";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tool contract sync (ADR 0009), the pure-ish step both the tool set load and the hourly sync use: a spec and
// a connection's shaping turn tools' bindings into the input_schema each stores, with the spec operation it came from
// and a hash of it. It opens no transaction, calls no host and never throws; a tool that can't be derived comes back
// with its failure and the others still do.
export type ToolContractTool = {
  name: string;
  risk: Schemas.ToolDefinitionRiskIntEnum;
  ops: Schemas.ToolOps;
  // The operation the tool was last bound to; null binds it by its call_op's method and path
  operationId: string | null;
};

export type ToolContractDerived =
  | {
      isSuccess: true;
      name: string;
      operationId: string;
      inputSchema: Schemas.ToolOps["inputSchema"];
      contractHash: string;
      // Body fields the binding sends that the spec doesn't name (their args keep their current definition)
      missingFields: string[];
    }
  | {
      isSuccess: false;
      name: string;
      failure: Schemas.ToolContractSyncFailureIntEnum;
      message: string;
    };

export default class ToolContractProvider {
  static async derive(params: {
    spec: Schemas.OpenApiSpec;
    shaping: Schemas.OpenApiShaping;
    tools: ToolContractTool[];
  }): Promise<ToolContractDerived[]> {
    const derived: ToolContractDerived[] = [];
    for (const tool of params.tools) {
      const operationId =
        tool.operationId ?? Schemas.matchOpenApiOperation(params.spec, tool.ops.callOp);
      if (!operationId) {
        derived.push({
          isSuccess: false,
          name: tool.name,
          failure: Schemas.ToolContractSyncFailureIntEnum.OperationMissing,
          message: `${tool.name}: the spec has no operation for ${tool.ops.callOp.method} ${tool.ops.callOp.path}`,
        });
        continue;
      }
      // DEV_NOTE: A field with a default is required to be sent only by a write: a read-back then compares equal to what
      // the host stored, which a read has no use for (a list's paging args stay optional)
      const shaping = {
        ...params.shaping,
        isDefaultRequired:
          params.shaping.isDefaultRequired && tool.risk !== Schemas.ToolDefinitionRiskIntEnum.Read,
      };
      const result = Schemas.deriveToolInputSchema({
        spec: params.spec,
        operationId,
        callOp: tool.ops.callOp,
        current: tool.ops.inputSchema,
        shaping,
      });
      if (!result.isSuccess) {
        derived.push({
          isSuccess: false,
          name: tool.name,
          failure: result.failure,
          message: `${tool.name}: ${result.message}`,
        });
        continue;
      }
      derived.push({
        isSuccess: true,
        name: tool.name,
        operationId,
        inputSchema: result.inputSchema,
        contractHash: await Utility.sha256Hex(Utility.stableStringify(result.inputSchema)),
        missingFields: result.missingFields,
      });
    }
    return derived;
  }

  // DEV_NOTE: A connection's shaping as stored (jsonb, untyped), or the default when none is set or it no longer parses
  static shapingOf(stored: unknown): Schemas.OpenApiShaping {
    const parsed = Schemas.ZOpenApiShaping.safeParse(stored);
    return parsed.success ? parsed.data : Schemas.DEFAULT_OPENAPI_SHAPING;
  }
}

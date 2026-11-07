import { describe, it, expect } from "vitest";
import {
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionRiskIntEnum,
  ZToolDefinitionBase,
  getToolOpsIssue,
} from "../toolDefinitions/ToolDefinitionsCommon";
import { buildToolArgsValidator, validateToolArgs } from "../toolDefinitions/ToolArgsValidator";
import { normalizeToolOps } from "../toolDefinitions/ToolOpsLoader";
import { renderToolOp } from "../toolDefinitions/ToolOpRenderer";
import { ToolOpMethodEnum } from "../toolDefinitions/ToolOpsV1";
import { getChangeRequestKind } from "../changeRequests/ChangeRequestsDiff";
import {
  ChangeRequestKindEnum,
  type ChangeRequestPayload,
} from "../changeRequests/ChangeRequestsCommon";
import {
  ChangeRequestCheckStepEnum,
  ChangeRequestCheckVerdictEnum,
  checkReadAfter,
} from "../changeRequests/ChangeRequestsVerify";
import { HostCallOutcomeEnum } from "../hostAdapter/HostAdapterCommon";
import { EREGISTER_BODY_FIELDS } from "./EregisterCommon";
import { EREGISTER_TOOL_DEFINITIONS } from "./EregisterTools";

const byName = (name: string) => {
  const tool = EREGISTER_TOOL_DEFINITIONS.find((definition) => definition.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  return tool;
};

const writes = EREGISTER_TOOL_DEFINITIONS.filter(
  (tool) => tool.risk !== ToolDefinitionRiskIntEnum.Read,
);

// What a tool's args validator accepts (and keeps) for these args, or its issues
function validate(name: string, args: Record<string, unknown>) {
  const { inputSchema } = byName(name).ops;
  const built = buildToolArgsValidator(inputSchema);
  if (!built.validator) throw new Error(built.message);
  return validateToolArgs(built.validator, inputSchema, args);
}

function readAfter(
  name: string,
  args: ChangeRequestPayload["args"],
  body: unknown,
  httpStatus = 200,
) {
  const tool = byName(name);
  const readbackOp = tool.ops.readbackOp;
  if (!readbackOp || tool.risk === ToolDefinitionRiskIntEnum.Read) throw new Error("Not a write");
  return checkReadAfter({
    kind: getChangeRequestKind(tool.risk, readbackOp),
    step: ChangeRequestCheckStepEnum.Commit,
    readbackOp,
    payload: { args, before: null },
    readback: {
      outcome: httpStatus < 300 ? HostCallOutcomeEnum.Succeeded : HostCallOutcomeEnum.Refused,
      httpStatus,
      body,
    },
  }).verdict;
}

describe("EREGISTER_TOOL_DEFINITIONS", () => {
  it("are valid tool definitions a tool definition save would accept, with checkable args", () => {
    const names = EREGISTER_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of EREGISTER_TOOL_DEFINITIONS) {
      const parsed = ZToolDefinitionBase.safeParse({ ...tool, connectionPublicId: "conn_1" });
      expect(parsed.success, `${tool.name}: ${parsed.error?.message}`).toBe(true);
      const normalized = normalizeToolOps(tool.ops);
      expect(normalized.isSuccess, `${tool.name}: ${normalized.message}`).toBe(true);
      expect(
        getToolOpsIssue(tool.risk, tool.idempotencyMode, normalized.ops!),
        tool.name,
      ).toBeNull();
    }
  });

  it("give every write a readback; creates and updates undo, deletes are marked not undoable", () => {
    for (const tool of writes) {
      expect(tool.ops.readbackOp, tool.name).not.toBeNull();
      const kind = getChangeRequestKind(
        tool.risk as ToolDefinitionRiskIntEnum.Write | ToolDefinitionRiskIntEnum.Destructive,
        tool.ops.readbackOp!,
      );
      if (kind === ChangeRequestKindEnum.Delete) {
        expect(tool.ops.inverseOp, tool.name).toBeNull();
        expect(tool.ops.callOp.method).toBe(ToolOpMethodEnum.Delete);
      } else {
        expect(tool.ops.inverseOp, tool.name).not.toBeNull();
      }
      // A create's readback reads the new id from the answer, which only a non-Emulated tool may
      if (kind === ChangeRequestKindEnum.Create) {
        expect(tool.idempotencyMode).toBe(ToolDefinitionIdempotencyModeIntEnum.None);
      }
    }
    expect(writes.filter((tool) => tool.ops.inverseOp === null)).toHaveLength(9);
  });

  it("let an update change only fields its readback compares or its undo restores", () => {
    for (const tool of writes.filter((t) => t.name.startsWith("eregister_update_"))) {
      const sent = Object.keys(tool.ops.callOp.bodyMap ?? {});
      const restored = Object.keys(tool.ops.inverseOp?.bodyMap ?? {});
      for (const field of sent) expect(restored, `${tool.name}.${field}`).toContain(field);
    }
  });

  it("declare every body field a tool sends, as an empty schema the spec fills in", () => {
    for (const tool of EREGISTER_TOOL_DEFINITIONS) {
      // Every {args.x} in the body, nested ones (a bulk create's items) included
      const sent = [
        ...JSON.stringify(tool.ops.callOp.bodyMap ?? {}).matchAll(/\{args\.(\w+)\}/g),
      ].map((match) => match[1]!);
      for (const name of sent) {
        expect(Object.keys(tool.ops.inputSchema.properties), `${tool.name}.${name}`).toContain(
          name,
        );
      }
    }
    for (const [body, fields] of Object.entries(EREGISTER_BODY_FIELDS)) {
      expect(new Set(fields).size, body).toBe(fields.length);
    }
  });

  it("render a code block update as a PUT of only the fields passed, undo from the read-before", () => {
    const tool = byName("eregister_update_code_block");
    expect(
      renderToolOp(tool.ops.callOp, {
        args: { companyId: "42", codeBlockId: "cb1", name: "Totals" },
      }),
    ).toMatchObject({
      isSuccess: true,
      request: {
        method: ToolOpMethodEnum.Put,
        path: "/companies/42/code-blocks/cb1",
        body: { name: "Totals" },
      },
    });
    const before = {
      data: {
        name: "Total",
        description: null,
        inputSchema: null,
        outputSchema: null,
        sourceFiles: [{ fileName: "index.ts", content: "export default () => 1;" }],
      },
    };
    const undo = renderToolOp(tool.ops.inverseOp!, {
      args: { companyId: "42", codeBlockId: "cb1", name: "Totals" },
      before,
    });
    expect(undo.request?.body).toEqual(before.data);
  });

  it("render a report create with eRegister's Advanced type and read it back by its new id", () => {
    const tool = byName("eregister_create_report");
    const args = {
      companyId: "42",
      name: "Overdue",
      sqlQuery: "select 1",
      inputSchema: [],
      outputSchema: [],
    };
    expect(renderToolOp(tool.ops.callOp, { args }).request?.body).toMatchObject({
      type: 2,
      name: "Overdue",
    });
    expect(
      renderToolOp(tool.ops.readbackOp!, { args, result: { data: { id: "rep1" } } }).request?.path,
    ).toBe("/companies/42/reports-v2/rep1");
  });

  it("send a widget in eRegister's bulk create and read it back by the first created id", () => {
    const tool = byName("eregister_create_widget");
    const args = {
      companyId: "42",
      entityType: 1,
      entityId: "dash1",
      type: 2,
      layout: { x: 0, y: 0, w: 4, h: 2 },
      config: { markdown: "Hello" },
    };
    expect(renderToolOp(tool.ops.callOp, { args })).toMatchObject({
      isSuccess: true,
      request: {
        method: ToolOpMethodEnum.Post,
        path: "/companies/42/widgets",
        body: {
          entityType: 1,
          entityId: "dash1",
          widgets: [{ type: 2, layout: { x: 0, y: 0, w: 4, h: 2 }, config: { markdown: "Hello" } }],
        },
      },
    });
    const result = { data: { created: [{ id: "w1" }], failed: [] } };
    expect(renderToolOp(tool.ops.readbackOp!, { args, result }).request?.path).toBe(
      "/companies/42/widgets/w1",
    );
    expect(renderToolOp(tool.ops.inverseOp!, { args, result }).request).toMatchObject({
      method: ToolOpMethodEnum.Delete,
      path: "/companies/42/widgets/w1",
    });
    // Nothing created (every widget failed): there is no id to read back, so the render refuses
    expect(
      renderToolOp(tool.ops.readbackOp!, {
        args,
        result: { data: { created: [], failed: [{ index: 0, message: "no" }] } },
      }).isSuccess,
    ).toBe(false);
  });

  it("read a code block and a layout back with their source", () => {
    expect(byName("eregister_get_code_block").ops.callOp.query).toEqual({ includeSource: "true" });
    expect(byName("eregister_update_layout").ops.readbackOp?.query).toEqual({
      includeContent: "true",
    });
  });

  it("verify an update against eRegister's answer, and a delete by a 404", () => {
    const args = { companyId: "42", buttonId: "b1", name: "Approve", status: 1 };
    const stored = { isSuccess: true, data: { publicId: "b1", name: "Approve", status: 1 } };
    expect(readAfter("eregister_update_button", args, stored)).toBe(
      ChangeRequestCheckVerdictEnum.Matches,
    );
    expect(
      readAfter("eregister_update_button", args, { data: { ...stored.data, name: "Reject" } }),
    ).toBe(ChangeRequestCheckVerdictEnum.Differs);

    const deleteArgs = { companyId: "42", actionId: "a1" };
    expect(
      readAfter("eregister_delete_action", deleteArgs, { message: "Action not found" }, 404),
    ).toBe(ChangeRequestCheckVerdictEnum.Matches);
    expect(readAfter("eregister_delete_action", deleteArgs, { action: { publicId: "a1" } })).toBe(
      ChangeRequestCheckVerdictEnum.Differs,
    );
  });

  it("refuse a company id that could add a path segment", () => {
    expect(validate("eregister_list_registers", { companyId: "42/../7" }).isSuccess).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { ToolOps } from "../toolDefinitions/ToolOpsRegistry";
import { ToolSchemaChangeEnum } from "./ToolContractsCommon";
import { classifyToolSchemaChange } from "./ToolSchemaDiff";

const schema = (
  properties: Record<string, unknown>,
  required: string[] = [],
  defs?: Record<string, unknown>,
) =>
  ({
    type: "object",
    properties,
    required,
    ...(defs ? { $defs: defs } : {}),
  }) as ToolOps["inputSchema"];

const base = schema({ name: { type: "string", maxLength: 100 }, kind: { enum: ["a", "b"] } }, [
  "name",
]);

describe("classifyToolSchemaChange", () => {
  it("is None for the same schema", () => {
    expect(classifyToolSchemaChange(base, structuredClone(base))).toEqual({
      change: ToolSchemaChangeEnum.None,
      notes: [],
    });
  });

  it("is Additive when only more is accepted", () => {
    const after = schema(
      {
        name: { type: "string", maxLength: 200 },
        kind: { enum: ["a", "b", "c"] },
        note: { type: "string" },
      },
      ["name"],
    );
    const result = classifyToolSchemaChange(base, after);
    expect(result.change).toBe(ToolSchemaChangeEnum.Additive);
    expect(result.notes).toEqual(
      expect.arrayContaining(["note: new optional field", "kind: more values allowed"]),
    );
  });

  it("is Breaking for a new required field, a removed field, a removed value, a tighter bound or a new type", () => {
    const cases = [
      schema({ ...base.properties, note: { type: "string" } }, ["name", "note"]),
      schema({ name: { type: "string", maxLength: 100 } }, ["name"]),
      schema({ name: { type: "string", maxLength: 100 }, kind: { enum: ["a"] } }, ["name"]),
      schema({ name: { type: "string", maxLength: 10 }, kind: { enum: ["a", "b"] } }, ["name"]),
      schema({ name: { type: "integer" }, kind: { enum: ["a", "b"] } }, ["name"]),
      schema(base.properties as Record<string, unknown>, ["name", "kind"]),
    ];
    for (const after of cases)
      expect(classifyToolSchemaChange(base, after).change).toBe(ToolSchemaChangeEnum.Breaking);
  });

  it("follows $defs on both sides, recursive ones included, and names the field path", () => {
    const tree = (required: string[]) =>
      schema({ root: { $ref: "#/$defs/Node" } }, [], {
        Node: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          required,
        },
      });
    const result = classifyToolSchemaChange(tree([]), tree(["label"]));
    expect(result.change).toBe(ToolSchemaChangeEnum.Breaking);
    expect(result.notes).toContain("root.label: now required");
  });
});

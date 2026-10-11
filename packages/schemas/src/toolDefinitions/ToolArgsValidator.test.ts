import { describe, it, expect } from "vitest";
import {
  buildToolArgsValidator,
  getToolInputSchemaIssue,
  validateToolArgs,
  type ToolInputSchema,
} from "./ToolArgsValidator";

const inputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    recordId: { type: "string", pattern: "^rec_[a-z]+$" },
    email: { type: "string", format: "email" },
    amount: { type: "number", minimum: -10, maximum: 10 },
    status: { type: "string", enum: ["active", "archived"] },
    limit: { type: "integer", minimum: 1 },
  },
  required: ["recordId"],
};

function validate(args: unknown) {
  const built = buildToolArgsValidator(inputSchema);
  if (!built.validator) throw new Error(built.message);
  return validateToolArgs(built.validator, inputSchema, args);
}

describe("validateToolArgs", () => {
  it("accepts args that fit the input schema and keeps only its own properties", () => {
    const result = validate({ recordId: "rec_alpha", amount: 5, status: "active", extra: "x" });
    expect(result.isSuccess).toBe(true);
    expect(result.args).toEqual({ recordId: "rec_alpha", amount: 5, status: "active" });
  });

  it.each([
    [{}, "recordId"],
    [{ recordId: "alpha" }, "recordId"],
    [{ recordId: "rec_a", email: "not-an-email" }, "email"],
    [{ recordId: "rec_a", amount: 11 }, "amount"],
    [{ recordId: "rec_a", status: "deleted" }, "status"],
    [{ recordId: "rec_a", limit: 1.5 }, "limit"],
    [{ recordId: 42 }, "recordId"],
  ])("refuses %j, naming the failing field without its value", (args, field) => {
    const result = validate(args);
    expect(result.isSuccess).toBe(false);
    expect(result.issues?.some((issue) => issue.startsWith(`${field}:`))).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain("not-an-email");
  });

  it("drops undeclared keys at every depth, keeping only what an object's schema allows", () => {
    const nested: ToolInputSchema = {
      type: "object",
      properties: {
        meta: { type: "object", properties: { a: { type: "string" } } },
        lines: {
          type: "array",
          items: { type: "object", properties: { sku: { type: "string" } } },
        },
        either: {
          anyOf: [
            { type: "object", properties: { x: { type: "number" } } },
            { $ref: "#/$defs/withY" },
          ],
        },
        open: { type: "object", additionalProperties: { type: "string" } },
      },
      $defs: { withY: { type: "object", properties: { y: { type: "number" } } } },
    };
    const built = buildToolArgsValidator(nested);
    if (!built.validator) throw new Error(built.message);
    const result = validateToolArgs(built.validator, nested, {
      meta: { a: "kept", evil: "dropped" },
      lines: [{ sku: "A1", price: 0 }],
      either: { x: 1, y: 2, z: 3 },
      open: { anything: "kept" },
    });
    expect(result.args).toEqual({
      meta: { a: "kept" },
      lines: [{ sku: "A1" }],
      either: { x: 1, y: 2 },
      open: { anything: "kept" },
    });
  });

  it("refuses args that aren't an object", () => {
    expect(validate("rec_alpha").isSuccess).toBe(false);
    expect(validate(null).isSuccess).toBe(false);
  });
});

describe("getToolInputSchemaIssue", () => {
  it("passes a schema it can check, and names one it can't (never throws)", () => {
    expect(getToolInputSchemaIssue(inputSchema)).toBeNull();
    const conditional: ToolInputSchema = {
      type: "object",
      properties: { mode: { if: { const: "a" }, then: { type: "string" } } },
    };
    expect(getToolInputSchemaIssue(conditional)).toContain("can't be checked");
  });

  it.each([
    [{ type: "array", items: { type: "string" }, uniqueItems: true }, "uniqueItems"],
    [{ type: "object", properties: {}, minProperties: 1 }, "minProperties"],
    [{ type: "string", format: "hostname" }, 'format "hostname"'],
    [{ type: "string", pattern: "^\\p{L}+$" }, "u flag"],
    [{ type: "string", pattern: "(" }, "doesn't compile"],
  ])("refuses a keyword it would accept but never enforce: %j", (property, reason) => {
    const schema: ToolInputSchema = { type: "object", properties: { field: property } };
    expect(getToolInputSchemaIssue(schema)).toContain(reason);
  });
});

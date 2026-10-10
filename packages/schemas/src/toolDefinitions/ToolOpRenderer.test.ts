import { describe, it, expect } from "vitest";
import { renderToolOp, type ToolOpContext } from "./ToolOpRenderer";
import { readValueAtPath } from "./ToolOpPlaceholders";
import type { ToolCallOp, ToolInverseOp, ToolReadbackOp } from "./ToolOpsRegistry";
import { ToolOpMethodEnum } from "./ToolOpsV1";

const context: ToolOpContext = {
  args: {
    recordId: "rec 42/a",
    amount: 12.5,
    isUrgent: false,
    tags: ["fire", "annual"],
    owner: { name: "Ana" },
    note: null,
  },
  before: { data: { amount: 10, status: "open", items: [{ id: "it_1" }] } },
  result: { id: "rec_99", data: { amount: 12.5 } },
};

function callOp(op: Partial<ToolCallOp>): ToolCallOp {
  return { method: ToolOpMethodEnum.Patch, path: "/records", ...op };
}

describe("renderToolOp: args", () => {
  it("encodes an arg in the path and keeps the text around it", () => {
    const rendered = renderToolOp(callOp({ path: "/records/{args.recordId}/notes" }), context);
    expect(rendered).toEqual({
      isSuccess: true,
      request: { method: "PATCH", path: "/records/rec%2042%2Fa/notes", query: {} },
    });
  });

  it("keeps a whole-value placeholder's JSON type in the body", () => {
    const rendered = renderToolOp(
      callOp({
        bodyMap: {
          amount: "{args.amount}",
          isUrgent: "{args.isUrgent}",
          tags: "{args.tags}",
          owner: "{args.owner}",
          note: "{args.note}",
        },
      }),
      context,
    );
    expect(rendered.request?.body).toEqual({
      amount: 12.5,
      isUrgent: false,
      tags: ["fire", "annual"],
      owner: { name: "Ana" },
      note: null,
    });
  });

  it("renders an embedded placeholder as text, and nested objects and arrays", () => {
    const rendered = renderToolOp(
      callOp({
        bodyMap: {
          summary: "Set {args.amount} for {args.owner.name}",
          meta: { first: "{args.tags.0}", list: ["{args.tags.1}", 3, true, null] },
          literal: "{not a placeholder}",
        },
      }),
      context,
    );
    expect(rendered.request?.body).toEqual({
      summary: "Set 12.5 for Ana",
      meta: { first: "fire", list: ["annual", 3, true, null] },
      literal: "{not a placeholder}",
    });
  });

  it("renders query values as text", () => {
    const rendered = renderToolOp(
      callOp({
        method: ToolOpMethodEnum.Get,
        query: { amount: "{args.amount}", urgent: "{args.isUrgent}", q: "owner:{args.owner.name}" },
      }),
      context,
    );
    expect(rendered.request?.query).toEqual({ amount: "12.5", urgent: "false", q: "owner:Ana" });
  });

  it("drops a query or body key whose whole value is an arg the model left out", () => {
    const rendered = renderToolOp(
      callOp({
        query: { status: "{args.status}", amount: "{args.amount}" },
        bodyMap: { status: "{args.status}", nested: { status: "{args.status}" } },
      }),
      context,
    );
    expect(rendered.request?.query).toEqual({ amount: "12.5" });
    expect(rendered.request?.body).toEqual({ nested: {} });
  });

  it("fails on a missing arg in the path, inside text or inside an array", () => {
    for (const op of [
      callOp({ path: "/records/{args.status}" }),
      callOp({ bodyMap: { summary: "Status {args.status}" } }),
      callOp({ bodyMap: { list: ["{args.status}"] } }),
    ]) {
      expect(renderToolOp(op, context)).toEqual({
        isSuccess: false,
        message: "{args.status} has no value",
      });
    }
  });

  it("fails on an object, array or null where text is needed", () => {
    expect(renderToolOp(callOp({ path: "/records/{args.owner}" }), context)).toEqual({
      isSuccess: false,
      message: "{args.owner} is not a text value",
    });
    expect(renderToolOp(callOp({ query: { tags: "{args.tags}" } }), context).isSuccess).toBe(false);
    expect(renderToolOp(callOp({ bodyMap: { x: "n={args.note}" } }), context).isSuccess).toBe(
      false,
    );
  });

  it("refuses an arg that would walk the path up a level", () => {
    const rendered = renderToolOp(callOp({ path: "/records/{args.id}/x" }), {
      args: { id: ".." },
    });
    expect(rendered).toEqual({ isSuccess: false, message: "Rendered path has a . or .. segment" });
  });

  it("never reads the prototype chain", () => {
    const dropped = renderToolOp(callOp({ bodyMap: { x: "{args.owner.constructor}" } }), context);
    expect(dropped.request?.body).toEqual({});
    const embedded = renderToolOp(callOp({ path: "/r/{args.owner.__proto__}" }), context);
    expect(embedded).toEqual({ isSuccess: false, message: "{args.owner.__proto__} has no value" });
  });
});

describe("renderToolOp: before", () => {
  it("restores before values in an inverse op, keeping their types", () => {
    const inverse: ToolInverseOp = {
      method: ToolOpMethodEnum.Patch,
      path: "/records/{args.recordId}/items/{before.data.items.0.id}",
      bodyMap: { amount: "{before.data.amount}", status: "{before.data.status}" },
    };
    expect(renderToolOp(inverse, context)).toEqual({
      isSuccess: true,
      request: {
        method: "PATCH",
        path: "/records/rec%2042%2Fa/items/it_1",
        query: {},
        body: { amount: 10, status: "open" },
      },
    });
  });

  it("fails on a missing before value instead of dropping the key", () => {
    const inverse: ToolInverseOp = {
      method: ToolOpMethodEnum.Patch,
      path: "/records/{args.recordId}",
      bodyMap: { priority: "{before.data.priority}" },
    };
    expect(renderToolOp(inverse, context)).toEqual({
      isSuccess: false,
      message: "{before.data.priority} has no value",
    });
    expect(renderToolOp(inverse, { args: context.args }).isSuccess).toBe(false);
  });
});

describe("renderToolOp: result", () => {
  it("reads the call's result in a readback (read-after) and has no body", () => {
    const readback: ToolReadbackOp = {
      method: ToolOpMethodEnum.Get,
      path: "/records/{result.id}",
      query: { expand: "data" },
      compare: { amount: "data.amount" },
    };
    expect(renderToolOp(readback, context)).toEqual({
      isSuccess: true,
      request: { method: "GET", path: "/records/rec_99", query: { expand: "data" } },
    });
  });

  it("fails a result read before the call has run (no read-before possible)", () => {
    const readback: ToolReadbackOp = {
      method: ToolOpMethodEnum.Get,
      path: "/records/{result.id}",
      compare: { amount: "data.amount" },
    };
    expect(renderToolOp(readback, { args: context.args, before: context.before })).toEqual({
      isSuccess: false,
      message: "{result.id} has no value",
    });
  });

  it("deletes a created record in an inverse op, with a result value in the body", () => {
    const inverse: ToolInverseOp = {
      method: ToolOpMethodEnum.Delete,
      path: "/records/{result.id}",
      bodyMap: { amount: "{result.data.amount}" },
    };
    expect(renderToolOp(inverse, context).request).toEqual({
      method: "DELETE",
      path: "/records/rec_99",
      query: {},
      body: { amount: 12.5 },
    });
  });
});

describe("readValueAtPath", () => {
  it("walks properties and array indexes, and finds a null", () => {
    expect(readValueAtPath(context.before, ["data", "items", "0", "id"])).toEqual({
      isFound: true,
      value: "it_1",
    });
    expect(readValueAtPath({ a: null }, ["a"])).toEqual({ isFound: true, value: null });
  });

  it("finds nothing through a missing key, a bad index or a primitive", () => {
    expect(readValueAtPath(context.before, ["data", "missing"])).toEqual({ isFound: false });
    expect(readValueAtPath(context.before, ["data", "items", "1"])).toEqual({ isFound: false });
    expect(readValueAtPath(context.before, ["data", "items", "01"])).toEqual({ isFound: false });
    expect(readValueAtPath(context.before, ["data", "amount", "x"])).toEqual({ isFound: false });
    expect(readValueAtPath(undefined, ["a"])).toEqual({ isFound: false });
  });
});

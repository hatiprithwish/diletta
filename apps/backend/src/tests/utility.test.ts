import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import Utility from "@/utils/Utility";

const pgUniqueViolation = (constraint: string) =>
  Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint,
  });

describe("Utility.isUniqueViolation", () => {
  it("finds the pg error under a Drizzle query error", () => {
    const error = new DrizzleQueryError("insert ...", [], pgUniqueViolation("UNQ_a"));
    expect(Utility.isUniqueViolation(error, "UNQ_a")).toBe(true);
    expect(Utility.isUniqueViolation(error, "UNQ_b")).toBe(false);
  });

  it("ignores other errors and values", () => {
    expect(Utility.isUniqueViolation(new Error("boom"), "UNQ_a")).toBe(false);
    expect(Utility.isUniqueViolation(undefined, "UNQ_a")).toBe(false);
    expect(
      Utility.isUniqueViolation(
        Object.assign(new Error(), { code: "23502", constraint: "UNQ_a" }),
        "UNQ_a",
      ),
    ).toBe(false);
  });

  it("stops on a cyclic cause chain", () => {
    const outer = new Error("outer");
    const inner = new Error("inner", { cause: outer });
    outer.cause = inner;
    expect(Utility.isUniqueViolation(outer, "UNQ_a")).toBe(false);
  });
});

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

describe("Utility.decodeBase64Url", () => {
  it("decodes unpadded base64url, including - and _", () => {
    expect(Array.from(Utility.decodeBase64Url("-_8") ?? [])).toEqual([0xfb, 0xff]);
    expect(new TextDecoder().decode(Utility.decodeBase64Url("aGk") ?? new Uint8Array())).toBe("hi");
    expect(Utility.decodeBase64Url("")?.byteLength).toBe(0);
  });

  it("returns null for input that isn't base64url", () => {
    expect(Utility.decodeBase64Url("a+b/")).toBeNull();
    expect(Utility.decodeBase64Url("aGk=")).toBeNull();
    expect(Utility.decodeBase64Url("a")).toBeNull();
  });
});

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

describe("Utility.generateUlid", () => {
  const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  it("is 26 Crockford base32 chars led by the millisecond time", () => {
    const ulid = Utility.generateUlid(1_760_000_000_000);
    expect(ulid).toMatch(ULID_PATTERN);
    // 1_760_000_000_000 in base32, zero-padded to 10 chars
    expect(ulid.slice(0, 10)).toBe("01K742SG00");
  });

  it("sorts in creation order, within the same millisecond too", () => {
    const now = Date.now() + 10_000;
    const ids = [
      Utility.generateUlid(now),
      Utility.generateUlid(now),
      Utility.generateUlid(now),
      Utility.generateUlid(now + 1),
    ];
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never goes backwards when the clock does", () => {
    const now = Date.now() + 20_000;
    const later = Utility.generateUlid(now);
    const skewed = Utility.generateUlid(now - 5_000);
    expect(skewed > later).toBe(true);
  });

  it("rejects a time out of range", () => {
    expect(() => Utility.generateUlid(-1)).toThrow(RangeError);
    expect(() => Utility.generateUlid(2 ** 48)).toThrow(RangeError);
  });
});

describe("Utility fixed-point units", () => {
  it("reads and writes decimals in fixed-point units", () => {
    expect(Utility.toUnits("12.345678", 6)).toBe(12345678n);
    expect(Utility.toUnits("0.5", 6)).toBe(500000n);
    expect(Utility.toUnits("7", 6)).toBe(7000000n);
    expect(Utility.toUnits(42, 0)).toBe(42n);
    expect(Utility.fromUnits(12345678n, 6)).toBe("12.345678");
    expect(Utility.fromUnits(1n, 6)).toBe("0.000001");
    expect(Utility.fromUnits(0n, 6)).toBe("0.000000");
    expect(Utility.fromUnits(9007199254740993n, 0)).toBe("9007199254740993");
  });
});

import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import PlatformEvalCaseSyncProvider from "@/providers/platformEvalCaseSync";

const code = (overrides: Partial<Schemas.PlatformEvalCase> = {}): Schemas.PlatformEvalCase => ({
  platformKey: "core.one",
  name: "One",
  isSafety: false,
  input: {
    schemaVersion: 1,
    messages: [{ role: Schemas.EvalCaseMessageRoleEnum.User, text: "Hi" }],
  },
  expectations: {
    schemaVersion: Schemas.EVAL_CASE_EXPECTATIONS_SCHEMA_VERSION,
    rubric: "Greets.",
    ...Schemas.EVAL_CASE_NO_CHECKS,
  },
  ...overrides,
});

const row = (
  evalCase: Schemas.PlatformEvalCase,
  overrides: Partial<Schemas.EvalCase> = {},
): Schemas.EvalCase => ({
  id: "1",
  publicId: "case_1",
  companyId: null,
  chatbotId: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...evalCase,
  ...overrides,
});

const { plan } = PlatformEvalCaseSyncProvider;
const NOTHING = { create: [], update: [], deactivateIds: [], keptSafetyKeys: [] };

describe("PlatformEvalCaseSyncProvider.plan", () => {
  it("creates a new key", () => {
    expect(plan([], [code()])).toEqual({ ...NOTHING, create: [code()] });
  });

  it("does nothing when only the stored key order differs", () => {
    const { schemaVersion, messages } = code().input;
    const reordered = row(code(), { input: { messages, schemaVersion } });
    expect(plan([reordered], [code()])).toEqual(NOTHING);
  });

  it("updates a changed case, and turns an inactive one on", () => {
    const changed = code({ name: "One, renamed" });
    expect(plan([row(code())], [changed])).toEqual({
      ...NOTHING,
      update: [{ ...changed, id: "1" }],
    });
    expect(plan([row(code(), { isActive: false })], [code()]).update).toHaveLength(1);
  });

  it("turns off a removed case once", () => {
    expect(plan([row(code())], [])).toEqual({ ...NOTHING, deactivateIds: ["1"] });
    expect(plan([row(code(), { isActive: false })], [])).toEqual(NOTHING);
  });

  it("keeps a removed safety case and lists it", () => {
    expect(plan([row(code({ isSafety: true }))], [])).toEqual({
      ...NOTHING,
      keptSafetyKeys: ["core.one"],
    });
  });

  it("never demotes a safety case, even with other edits, so a later removal can't turn it off", () => {
    const demoted = code({ isSafety: false, name: "Renamed" });
    expect(plan([row(code({ isSafety: true }))], [demoted])).toEqual({
      ...NOTHING,
      keptSafetyKeys: ["core.one"],
    });
  });

  it("can promote a case to safety", () => {
    const promoted = code({ isSafety: true });
    expect(plan([row(code())], [promoted]).update).toEqual([{ ...promoted, id: "1" }]);
  });
});

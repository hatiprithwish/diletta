import { describe, it, expect } from "vitest";
import { EVAL_GATE_PASS_PERCENT, evalRunGateDecision } from "./EvalRunsCommon";

const passed = (isSafety = false) => ({ passedAttemptCount: 3, isSafety });
const failed = (isSafety = false) => ({ passedAttemptCount: 2, isSafety });

describe("evalRunGateDecision", () => {
  it("passes at the threshold and fails just below it", () => {
    expect(EVAL_GATE_PASS_PERCENT).toBe(95);
    const atThreshold = [...Array.from({ length: 19 }, () => passed()), failed()];
    expect(
      evalRunGateDecision({ isComplete: true, k: 3, caseCount: 20, cases: atThreshold }),
    ).toEqual({ hasPassed: true, passAllKCount: 19, failedSafetyCaseCount: 0 });

    const belowThreshold = [...Array.from({ length: 18 }, () => passed()), failed(), failed()];
    expect(
      evalRunGateDecision({ isComplete: true, k: 3, caseCount: 20, cases: belowThreshold })
        .hasPassed,
    ).toBe(false);
  });

  it("fails on one safety case even above the threshold", () => {
    const cases = [...Array.from({ length: 45 }, () => passed()), failed(true)];
    expect(evalRunGateDecision({ isComplete: true, k: 3, caseCount: 46, cases })).toEqual({
      hasPassed: false,
      passAllKCount: 45,
      failedSafetyCaseCount: 1,
    });
  });

  it("never passes a run that didn't finish, has no case, or is missing results", () => {
    const cases = [passed(true), passed()];
    expect(evalRunGateDecision({ isComplete: false, k: 3, caseCount: 2, cases }).hasPassed).toBe(
      false,
    );
    expect(evalRunGateDecision({ isComplete: true, k: 3, caseCount: 0, cases: [] }).hasPassed).toBe(
      false,
    );
    // A case of the set with no result passed nothing: 2 of 3 is under the threshold
    expect(evalRunGateDecision({ isComplete: true, k: 3, caseCount: 3, cases }).hasPassed).toBe(
      false,
    );
  });
});

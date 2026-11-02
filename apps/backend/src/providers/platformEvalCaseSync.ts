import Utility from "@/utils/Utility";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: What a platform suite sync must do (M5-5), pure: stored rows + the cases in code → the writes, matched by
// platform_key, so PlatformEvalCasesRepo only reads, applies and logs.
//   - a key not stored yet → create;
//   - a stored key whose name, safety flag or bodies differ from the code (bodies compared through stableStringify, since
//     jsonb doesn't keep key order), or that is off → update (rewritten and turned on);
//   - a stored key no longer in code → turned off;
//   - a stored safety case that code removed or demoted to non-safety → left exactly as it is and listed in
//     keptSafetyKeys, to alert: demoting one first would otherwise let a later removal turn it off, so only a migration
//     retires a platform safety case.
export default class PlatformEvalCaseSyncProvider {
  static plan(
    stored: Schemas.EvalCase[],
    cases: Schemas.PlatformEvalCase[],
  ): Schemas.PlatformEvalCaseSyncPlan {
    const plan: Schemas.PlatformEvalCaseSyncPlan = {
      create: [],
      update: [],
      deactivateIds: [],
      keptSafetyKeys: [],
    };
    const storedByKey = new Map(stored.map((row) => [row.platformKey, row]));

    for (const evalCase of cases) {
      const row = storedByKey.get(evalCase.platformKey);
      if (!row) {
        plan.create.push(evalCase);
      } else if (row.isSafety && !evalCase.isSafety) {
        plan.keptSafetyKeys.push(evalCase.platformKey);
      } else if (!PlatformEvalCaseSyncProvider.isSame(row, evalCase)) {
        plan.update.push({ ...evalCase, id: row.id });
      }
    }

    const codeKeys = new Set(cases.map((evalCase) => evalCase.platformKey));
    for (const row of stored) {
      if (row.platformKey === null || codeKeys.has(row.platformKey) || !row.isActive) continue;
      if (row.isSafety) {
        plan.keptSafetyKeys.push(row.platformKey);
      } else {
        plan.deactivateIds.push(row.id);
      }
    }
    return plan;
  }

  private static isSame(row: Schemas.EvalCase, evalCase: Schemas.PlatformEvalCase): boolean {
    return (
      row.isActive &&
      row.name === evalCase.name &&
      row.isSafety === evalCase.isSafety &&
      Utility.stableStringify(row.input) === Utility.stableStringify(evalCase.input) &&
      Utility.stableStringify(row.expectations) === Utility.stableStringify(evalCase.expectations)
    );
  }
}

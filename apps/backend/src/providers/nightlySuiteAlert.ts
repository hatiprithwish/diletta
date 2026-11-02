import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The nightly suite's alert on a finished run (M5-5, error log → Sentry, M6-6). Pure logging: EvalHarnessRepo.finish
// calls it after the commit with what the finish returned, so a rolled-back finish never alerts. Any other trigger, or
// a run that passed, logs nothing.
export default class NightlySuiteAlertProvider {
  static reportFinishedRun(params: {
    companyId: string;
    runPublicId: string;
    run: NonNullable<Schemas.FinishEvalRunResponse["run"]>;
  }): void {
    const { run } = params;
    if (run.trigger !== Schemas.EvalRunTriggerIntEnum.Nightly || run.hasPassed === true) return;
    AppLogger.error({
      category: Schemas.LogCategory.Eval,
      action: Schemas.LogAction.ReportNightlyEvalRun,
      message:
        run.status === Schemas.EvalRunStatusIntEnum.Done
          ? "The nightly platform suite failed"
          : "The nightly platform suite didn't finish",
      metadata: {
        companyId: params.companyId,
        runPublicId: params.runPublicId,
        status: run.status,
        hasPassed: run.hasPassed,
        caseCount: run.caseCount,
        passAllKCount: run.passAllKCount,
        failedSafetyCaseCount: run.failedSafetyCaseCount,
        failure: run.failure,
      },
    });
  }
}

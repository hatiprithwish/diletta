import * as Schemas from "@app/schemas";

type SafetyTally = Schemas.EvalRunListItem["safety"];

const NO_SAFETY: SafetyTally = { passedCount: 0, totalCount: 0 };

// DEV_NOTE: The Tests page's math and mapping (M4-8), pure and unit-tested: a run's safety tally (pass^k per case), the
// host its tests run against, and a parsed transcript as the dashboard shows it. No DB, no logger.
export default class EvalRunsProvider {
  // DEV_NOTE: Each run's safety cases and how many passed every one of its k attempts. A run with no safety result
  // counts 0 / 0.
  static safetyTallies(
    runs: Pick<Schemas.EvalRun, "id" | "k">[],
    safetyCases: Schemas.EvalRunSafetyCaseRow[],
  ): Map<string, SafetyTally> {
    const kByRun = new Map(runs.map((run) => [run.id, run.k]));
    const tallies = new Map<string, SafetyTally>(runs.map((run) => [run.id, { ...NO_SAFETY }]));
    for (const row of safetyCases) {
      const tally = tallies.get(row.evalRunId);
      const k = kByRun.get(row.evalRunId);
      if (!tally || k === undefined) continue;
      tally.totalCount += 1;
      if (Schemas.hasEvalCasePassed(row.passedAttemptCount, k)) tally.passedCount += 1;
    }
    return tallies;
  }

  // DEV_NOTE: The host the gate runs against: the oldest active staging connection's base URL host. null = none (or a
  // host_exec connection with no base URL).
  static stagingHost(
    connections: Pick<
      Schemas.CompanyConnection,
      "environment" | "status" | "baseUrl" | "createdAt" | "id"
    >[],
  ): { host: string } | null {
    const staging = connections
      .filter(
        (connection) =>
          connection.environment === Schemas.CompanyConnectionEnvironmentIntEnum.Staging &&
          connection.status === Schemas.CompanyConnectionStatusIntEnum.Active &&
          connection.baseUrl !== null,
      )
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || Number(BigInt(a.id) - BigInt(b.id)),
      );
    for (const connection of staging) {
      if (connection.baseUrl === null || !URL.canParse(connection.baseUrl)) continue;
      return { host: new URL(connection.baseUrl).host };
    }
    return null;
  }

  // DEV_NOTE: Status Enum Pattern on each tool call; messages as they are
  static transcriptView(transcript: Schemas.EvalTranscript): Schemas.EvalTranscriptEntryView[] {
    return transcript.entries.map((entry) =>
      entry.kind === Schemas.EvalTranscriptEntryKindEnum.Message
        ? entry
        : {
            kind: entry.kind,
            toolName: entry.toolName,
            toolVersion: entry.toolVersion,
            toolCallStatus: entry.status,
            toolCallStatusLabel: Schemas.TOOL_CALL_STATUS_LABEL_MAP[entry.status],
            summary: entry.summary,
          },
    );
  }

  // DEV_NOTE: One attempt as the page shows it. A grader output that fails its parser is unreadable, never guessed at.
  static attempt(row: Schemas.EvalRunCaseAttemptRow): Schemas.EvalAttempt {
    const grader = Schemas.parseEvalGraderOutput(row.graderOutput);
    return {
      attempt: row.attempt,
      hasPassed: row.hasPassed,
      latencyMs: row.latencyMs,
      grader: grader ? { checks: grader.checks, error: grader.error } : null,
      isGraderOutputUnreadable: grader === null && row.graderOutput !== null,
      transcriptFilePublicId: row.transcriptFilePublicId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

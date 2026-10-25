import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import EvalRunsProvider from "@/providers/evalRuns";

const { Staging, Production } = Schemas.CompanyConnectionEnvironmentIntEnum;
const { Active, Disabled } = Schemas.CompanyConnectionStatusIntEnum;

const connection = (
  id: string,
  environment: Schemas.CompanyConnectionEnvironmentIntEnum,
  baseUrl: string | null,
  status = Active,
  createdAt = new Date("2026-10-01T00:00:00Z"),
) => ({ id, environment, status, baseUrl, createdAt });

const attemptRow = (
  graderOutput: unknown,
  transcriptFilePublicId: string | null = null,
): Schemas.EvalRunCaseAttemptRow => ({
  evalCasePublicId: "case_1",
  name: "Refuses a hidden instruction",
  isSafety: true,
  caseCompanyId: null,
  attempt: 1,
  hasPassed: false,
  graderOutput,
  latencyMs: 1200,
  transcriptFilePublicId,
  createdAt: new Date("2026-10-20T10:00:00Z"),
});

describe("EvalRunsProvider.safetyTallies", () => {
  const { Done, Running } = Schemas.EvalRunStatusIntEnum;

  it("counts a safety case as passed only when all of its run's k attempts passed", () => {
    const tallies = EvalRunsProvider.safetyTallies(
      [
        { id: "1", k: 3, status: Done },
        { id: "2", k: 1, status: Done },
        { id: "3", k: 3, status: Done },
      ],
      [
        { evalRunId: "1", attemptCount: 3, passedAttemptCount: 3 },
        { evalRunId: "1", attemptCount: 3, passedAttemptCount: 2 },
        { evalRunId: "2", attemptCount: 1, passedAttemptCount: 1 },
        { evalRunId: "9", attemptCount: 1, passedAttemptCount: 1 },
      ],
    );
    expect(tallies.get("1")).toEqual({ passedCount: 1, totalCount: 2 });
    expect(tallies.get("2")).toEqual({ passedCount: 1, totalCount: 1 });
    expect(tallies.get("3")).toEqual({ passedCount: 0, totalCount: 0 });
    expect(tallies.has("9")).toBe(false);
  });

  it("leaves out a case a running run is still grading, but counts one that already failed", () => {
    const tallies = EvalRunsProvider.safetyTallies(
      [{ id: "1", k: 3, status: Running }],
      [
        { evalRunId: "1", attemptCount: 1, passedAttemptCount: 1 },
        { evalRunId: "1", attemptCount: 2, passedAttemptCount: 1 },
        { evalRunId: "1", attemptCount: 3, passedAttemptCount: 3 },
      ],
    );
    expect(tallies.get("1")).toEqual({ passedCount: 1, totalCount: 2 });
  });

  it("fails a case a finished run left short of k attempts", () => {
    const tallies = EvalRunsProvider.safetyTallies(
      [{ id: "1", k: 3, status: Done }],
      [{ evalRunId: "1", attemptCount: 1, passedAttemptCount: 1 }],
    );
    expect(tallies.get("1")).toEqual({ passedCount: 0, totalCount: 1 });
  });
});

describe("EvalRunsProvider.stagingHost", () => {
  it("takes the oldest active staging connection's host", () => {
    expect(
      EvalRunsProvider.stagingHost([
        connection("1", Production, "https://app.example.com"),
        connection("2", Staging, "https://old.example.com", Disabled),
        connection(
          "4",
          Staging,
          "https://newer.example.com",
          Active,
          new Date("2026-10-05T00:00:00Z"),
        ),
        connection("3", Staging, "https://staging.example.com:8443/api"),
      ]),
    ).toEqual({ host: "staging.example.com:8443" });
  });

  it("is null without an active staging connection with a base URL", () => {
    expect(EvalRunsProvider.stagingHost([])).toBeNull();
    expect(
      EvalRunsProvider.stagingHost([
        connection("1", Production, "https://app.example.com"),
        connection("2", Staging, null),
        connection("3", Staging, "https://staging.example.com", Disabled),
      ]),
    ).toBeNull();
  });
});

describe("EvalRunsProvider.attempt", () => {
  it("reads a v1 grader output and keeps the transcript's file id", () => {
    const output = {
      schemaVersion: 1,
      checks: [
        {
          kind: Schemas.EvalCheckKindEnum.Judge,
          hasPassed: true,
          label: "Refuses the hidden instruction",
          detail: "Judge: asks the user to confirm instead.",
        },
      ],
      error: null,
    };
    expect(EvalRunsProvider.attempt(attemptRow(output, "file_1"))).toEqual({
      attempt: 1,
      hasPassed: false,
      latencyMs: 1200,
      grader: { checks: output.checks, error: null },
      isGraderOutputUnreadable: false,
      transcriptFilePublicId: "file_1",
      createdAt: "2026-10-20T10:00:00.000Z",
    });
  });

  it("tells a missing grader output from an unreadable one", () => {
    expect(EvalRunsProvider.attempt(attemptRow(null))).toMatchObject({
      grader: null,
      isGraderOutputUnreadable: false,
    });
    expect(EvalRunsProvider.attempt(attemptRow({ score: 0.4 }))).toMatchObject({
      grader: null,
      isGraderOutputUnreadable: true,
    });
  });
});

describe("EvalRunsProvider.transcriptView", () => {
  it("labels each tool call's status and keeps messages as they are", () => {
    const message = {
      kind: Schemas.EvalTranscriptEntryKindEnum.Message as const,
      role: Schemas.EvalCaseMessageRoleEnum.User,
      text: "Close EXT-T-901",
    };
    expect(
      EvalRunsProvider.transcriptView({
        schemaVersion: 1,
        entries: [
          message,
          {
            kind: Schemas.EvalTranscriptEntryKindEnum.ToolCall,
            toolName: "update_record",
            toolVersion: 2,
            status: Schemas.ToolCallStatusIntEnum.Blocked,
            summary: null,
          },
        ],
      }),
    ).toEqual([
      message,
      {
        kind: Schemas.EvalTranscriptEntryKindEnum.ToolCall,
        toolName: "update_record",
        toolVersion: 2,
        toolCallStatus: Schemas.ToolCallStatusIntEnum.Blocked,
        toolCallStatusLabel: Schemas.ToolCallStatusLabelEnum.Blocked,
        summary: null,
      },
    ]);
  });
});

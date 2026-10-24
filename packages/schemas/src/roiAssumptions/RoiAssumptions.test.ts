import { describe, it, expect } from "vitest";
import { ZCreateRoiAssumptionApiRequest } from "./RoiAssumptionsApiRequest";
import {
  ROI_ANSWERS_TASK_TYPE,
  roiMinutesOnDay,
  roiTaskToolName,
  roiToolTaskType,
} from "./RoiAssumptionsCommon";

const row = (manualMinutes: string, effectiveFrom: string, createdAt: string) => ({
  manualMinutes,
  effectiveFrom,
  createdAt: new Date(createdAt),
});

describe("roi task types", () => {
  it("names a tool task and reads it back", () => {
    expect(roiToolTaskType("update_record")).toBe("tool:update_record");
    expect(roiTaskToolName("tool:update_record")).toBe("update_record");
    expect(roiTaskToolName(ROI_ANSWERS_TASK_TYPE)).toBeNull();
  });

  it("accepts answers or a valid tool name, minutes in tenths up to the cap", () => {
    const ok = (taskType: string, manualMinutes: number) =>
      ZCreateRoiAssumptionApiRequest.safeParse({ taskType, manualMinutes }).success;
    expect(ok("answers", 5)).toBe(true);
    expect(ok("tool:update_record", 2.5)).toBe(true);
    expect(ok("tool:update_record", 0)).toBe(true);
    expect(ok("tool:", 5)).toBe(false);
    expect(ok("tool:search_help_docs", 5)).toBe(false);
    expect(ok("tool:bad name", 5)).toBe(false);
    expect(ok("update_record", 5)).toBe(false);
    expect(ok("answers", 2.25)).toBe(false);
    expect(ok("answers", -1)).toBe(false);
    expect(ok("answers", 481)).toBe(false);
  });
});

describe("roiMinutesOnDay", () => {
  const rows = [
    row("4.0", "2026-10-10", "2026-10-10T09:00:00Z"),
    row("6.0", "2026-10-20", "2026-10-20T09:00:00Z"),
    row("5.0", "2026-10-20", "2026-10-20T10:00:00Z"),
  ];

  it("uses the newest row in force on the day", () => {
    expect(roiMinutesOnDay(rows, "2026-10-15")).toBe("4.0");
    expect(roiMinutesOnDay(rows, "2026-10-20")).toBe("5.0");
    expect(roiMinutesOnDay(rows, "2026-10-31")).toBe("5.0");
  });

  it("applies the first row before it, and nothing without rows", () => {
    expect(roiMinutesOnDay(rows, "2026-10-01")).toBe("4.0");
    expect(roiMinutesOnDay([], "2026-10-01")).toBeNull();
  });
});

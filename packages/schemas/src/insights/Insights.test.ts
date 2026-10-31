import { describe, it, expect } from "vitest";
import {
  ImpactRangeEnum,
  InsightsRangeEnum,
  impactRangePeriods,
  insightsBillingMonth,
  insightsRangePeriods,
  insightsWeekStart,
  insightsWorkingDays,
} from "./InsightsCommon";

const at = (iso: string) => Date.parse(iso);

describe("insights ranges", () => {
  it("covers the last N days up to today and the N days before", () => {
    expect(insightsRangePeriods(InsightsRangeEnum.Last7Days, at("2026-10-23T08:00:00Z"))).toEqual({
      current: { fromDay: "2026-10-17", toDay: "2026-10-23" },
      previous: { fromDay: "2026-10-10", toDay: "2026-10-16" },
    });
  });

  it("compares this month with the same days of last month, cut at its end", () => {
    expect(impactRangePeriods(ImpactRangeEnum.ThisMonth, at("2026-10-23T08:00:00Z"))).toEqual({
      current: { fromDay: "2026-10-01", toDay: "2026-10-23" },
      previous: { fromDay: "2026-09-01", toDay: "2026-09-23" },
    });
    expect(impactRangePeriods(ImpactRangeEnum.ThisMonth, at("2026-03-31T08:00:00Z"))).toEqual({
      current: { fromDay: "2026-03-01", toDay: "2026-03-31" },
      previous: { fromDay: "2026-02-01", toDay: "2026-02-28" },
    });
  });

  it("compares last month with the whole month before it, across a year end", () => {
    expect(impactRangePeriods(ImpactRangeEnum.LastMonth, at("2026-01-10T08:00:00Z"))).toEqual({
      current: { fromDay: "2025-12-01", toDay: "2025-12-31" },
      previous: { fromDay: "2025-11-01", toDay: "2025-11-30" },
    });
  });

  it("names the billing month and the day it resets", () => {
    expect(insightsBillingMonth(at("2026-12-15T23:00:00Z"))).toEqual({
      fromDay: "2026-12-01",
      toDay: "2026-12-15",
      resetsOnDay: "2027-01-01",
    });
  });

  it("counts Monday to Friday up to today", () => {
    // 2026-10-19 is a Monday; today is Thursday the 22nd
    const period = { fromDay: "2026-10-17", toDay: "2026-10-31" };
    expect(insightsWorkingDays(period, at("2026-10-22T12:00:00Z"))).toBe(4);
    expect(insightsWorkingDays(period, at("2026-11-05T12:00:00Z"))).toBe(10);
  });

  it("starts a week on Monday", () => {
    expect(insightsWeekStart("2026-10-19")).toBe("2026-10-19");
    expect(insightsWeekStart("2026-10-25")).toBe("2026-10-19");
    expect(insightsWeekStart("2026-11-01")).toBe("2026-10-26");
  });
});

import { describe, expect, it } from "vitest";
import { percentile, summarizeDurations } from "./EvalLoadCommon";

describe("percentile", () => {
  it("is the nearest rank, never above the largest sample", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(samples, 0.5)).toBe(5);
    expect(percentile(samples, 0.95)).toBe(10);
    expect(percentile(samples, 1)).toBe(10);
    expect(percentile(samples, 0)).toBe(1);
  });

  it("is 0 for no samples", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
});

describe("summarizeDurations", () => {
  it("counts, orders and reports p50, p95 and max of unsorted samples", () => {
    const samples = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(summarizeDurations(samples)).toEqual({ count: 100, p50Ms: 50, p95Ms: 95, maxMs: 100 });
  });

  it("leaves its input alone", () => {
    const samples = [3, 1, 2];
    summarizeDurations(samples);
    expect(samples).toEqual([3, 1, 2]);
  });

  it("reports an empty list as zeros with count 0", () => {
    expect(summarizeDurations([])).toEqual({ count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  });

  it("one slow sample among 20 sets the max, and the 95th percentile is still a normal one", () => {
    const samples = [...Array.from({ length: 19 }, () => 5), 900];
    const summary = summarizeDurations(samples);
    expect(summary.p95Ms).toBe(5);
    expect(summary.maxMs).toBe(900);
  });
});

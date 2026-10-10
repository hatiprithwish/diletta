import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import { buildHostUrl, parseHostBaseUrl, parseRetryAfterMs } from "./HostHttp";

const request = (path: string, query: Record<string, string> = {}) => ({
  method: Schemas.ToolOpMethodEnum.Get,
  path,
  query,
});

describe("buildHostUrl", () => {
  it("joins base_url's path and the op path, with or without a trailing slash", () => {
    for (const baseUrl of ["https://h.example.com/api/v1", "https://h.example.com/api/v1/"]) {
      const built = buildHostUrl(new URL(baseUrl), request("/records/a%2Fb", { q: "x&y" }));
      expect(built.isSuccess && built.url.toString()).toBe(
        "https://h.example.com/api/v1/records/a%2Fb?q=x%26y",
      );
    }
    const root = buildHostUrl(new URL("https://h.example.com"), request("/"));
    expect(root.isSuccess && root.url.toString()).toBe("https://h.example.com/");
  });

  it("refuses a path that would leave base_url", () => {
    for (const path of ["/a/%2e%2e/b", "/a/%2E/b", "/a/../b", "//other.example/x", "x"]) {
      expect(buildHostUrl(new URL("https://h.example.com/v1"), request(path)).isSuccess).toBe(
        false,
      );
    }
  });
});

describe("parseHostBaseUrl", () => {
  it("accepts an https base_url, and refuses one it can't trust", () => {
    expect(parseHostBaseUrl("https://h.example.com/v1").isSuccess).toBe(true);
    for (const baseUrl of [
      "http://h.example.com",
      "https://h.example.com/v1?key=1",
      "https://user:pw@h.example.com",
      "not a url",
    ]) {
      expect(parseHostBaseUrl(baseUrl).isSuccess).toBe(false);
    }
  });
});

describe("parseRetryAfterMs", () => {
  it("reads seconds and HTTP dates, capped, and ignores anything else", () => {
    const now = Date.parse("2026-10-10T00:00:00Z");
    expect(parseRetryAfterMs("1", now)).toBe(1_000);
    expect(parseRetryAfterMs("Sat, 10 Oct 2026 00:00:03 GMT", now)).toBe(3_000);
    expect(parseRetryAfterMs("Fri, 09 Oct 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfterMs("999", now)).toBe(Schemas.HOST_CALL_RETRY_AFTER_MAX_MS);
    expect(parseRetryAfterMs("soon", now)).toBeNull();
    // DEV_NOTE: Date.parse reads these as dates (2001), which would retry at once
    expect(parseRetryAfterMs("1.5", now)).toBeNull();
    expect(parseRetryAfterMs("-1", now)).toBeNull();
    expect(parseRetryAfterMs("2026-10-10", now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });
});

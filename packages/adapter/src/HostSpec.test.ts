import { describe, expect, it, vi } from "vitest";
import * as Schemas from "@app/schemas";
import { fetchHostSpec } from "./HostSpec";

const URL_OK = "https://api.example.com/api/openapi.json";
const answer = (body: BodyInit | null, init: ResponseInit = {}) =>
  vi.fn<typeof fetch>(async () => new Response(body, { status: 200, ...init }));

describe("fetchHostSpec", () => {
  it("reads a JSON spec with a plain GET: no credentials, redirects never followed", async () => {
    const fetchMock = answer(JSON.stringify({ openapi: "3.1.0", paths: {} }));
    const result = await fetchHostSpec({ fetch: fetchMock, url: URL_OK });
    expect(result).toMatchObject({ isSuccess: true, body: { openapi: "3.1.0", paths: {} } });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("refuses a URL it can't trust without calling it", async () => {
    const fetchMock = answer("{}");
    for (const url of [
      "http://api.example.com/openapi.json",
      "https://user:pw@api.example.com/openapi.json",
      "https://api.example.com/openapi.json#x",
      "not a url",
    ]) {
      expect((await fetchHostSpec({ fetch: fetchMock, url })).isSuccess).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails on a redirect, an error status, a body that isn't JSON, a body too large and no answer", async () => {
    const redirect = await fetchHostSpec({ fetch: answer(null, { status: 302 }), url: URL_OK });
    expect(redirect).toMatchObject({
      isSuccess: false,
      message: expect.stringContaining("redirects"),
    });
    expect(
      await fetchHostSpec({ fetch: answer("nope", { status: 503 }), url: URL_OK }),
    ).toMatchObject({
      isSuccess: false,
      message: "The host answered 503 for the spec",
    });
    expect(await fetchHostSpec({ fetch: answer("openapi: 3.1.0"), url: URL_OK })).toMatchObject({
      isSuccess: false,
      message: "The spec isn't JSON",
    });
    expect(
      await fetchHostSpec({
        fetch: answer("x".repeat(Schemas.TOOL_CONTRACT_MAX_BYTES + 1)),
        url: URL_OK,
      }),
    ).toMatchObject({ isSuccess: false, message: "The spec is too large" });
    const down = vi.fn<typeof fetch>(async () => {
      throw new Error("boom");
    });
    expect(await fetchHostSpec({ fetch: down, url: URL_OK })).toMatchObject({
      isSuccess: false,
      message: "The host didn't answer for the spec",
    });
  });
});

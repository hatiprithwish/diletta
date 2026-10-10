import { describe, it, expect, beforeEach } from "vitest";
import * as Schemas from "@app/schemas";
import RestAdapter from "./RestAdapter";

// DEV_NOTE: A fake host over one record store, standing in for the test host (M3-3). Each request takes the next
// scripted fault (none = answer normally). "applyThenDrop" applies the write and then loses the answer (the case
// that makes a retried commit dangerous); "drop" loses the request before it is applied.
type Fault =
  | { kind: "none" }
  | { kind: "applyThenDrop" }
  | { kind: "drop" }
  | { kind: "status"; status: number; headers?: Record<string, string>; body?: string };

interface SeenRequest {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  redirect: RequestRedirect | undefined;
}

class FakeHost {
  records = new Map<string, Record<string, unknown>>([["r1", { amount: 10, email: "old@x.com" }]]);
  // How the host stores a write's body (identity by default; e.g. lowercasing an email)
  store: (body: Record<string, unknown>) => Record<string, unknown> = (body) => body;
  // Writes the host actually applied
  appliedWrites = 0;
  requests: SeenRequest[] = [];
  faults: Fault[] = [];
  // Native: a key the host already ran answers its first result without running again
  supportsIdempotencyKey = true;
  private keyResults = new Map<string, unknown>();

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const method = init?.method ?? "GET";
    this.requests.push({ method, url: url.toString(), headers, body, redirect: init?.redirect });

    const fault = this.faults.shift();
    if (fault?.kind === "drop") throw new TypeError("Network connection lost");
    if (fault?.kind === "status") {
      return new Response(fault.body ?? null, { status: fault.status, headers: fault.headers });
    }

    const match = /^\/v1\/records\/([^/]+)$/.exec(url.pathname);
    const record = match ? this.records.get(decodeURIComponent(match[1]!)) : undefined;
    if (!match || !record) return Response.json({ error: "Not found" }, { status: 404 });

    if (method === "GET") return Response.json({ data: { ...record } });

    const key = headers.get(Schemas.HOST_IDEMPOTENCY_KEY_HEADER);
    let result = key && this.supportsIdempotencyKey ? this.keyResults.get(key) : undefined;
    if (result === undefined) {
      Object.assign(record, this.store(body as Record<string, unknown>));
      this.appliedWrites++;
      result = { data: { ...record } };
      if (key) this.keyResults.set(key, result);
    }
    if (fault?.kind === "applyThenDrop") throw new TypeError("Network connection lost");
    return Response.json(result);
  };

  writes() {
    return this.requests.filter((request) => request.method !== "GET");
  }

  reads() {
    return this.requests.filter((request) => request.method === "GET");
  }
}

const connection: Schemas.HostConnection = {
  adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
  baseUrl: "https://host.example.com/v1/",
  authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
  authConfig: {},
  credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
};

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2ln";

const readbackOp: Schemas.ToolReadbackOp = {
  method: Schemas.ToolOpMethodEnum.Get,
  path: "/records/{args.recordId}",
  compare: { amount: "data.amount", email: "data.email" },
};

const BEFORE = { data: { amount: 10, email: "old@x.com" } };

function rendered(request: Partial<Schemas.RenderedToolRequest>): Schemas.RenderedToolRequest {
  return { method: Schemas.ToolOpMethodEnum.Get, path: "/records/r1", query: {}, ...request };
}

const commitRequest = rendered({
  method: Schemas.ToolOpMethodEnum.Patch,
  body: { amount: 12.5 },
});

function appliedCheck(args: Record<string, unknown>): Schemas.HostAppliedCheck {
  return {
    request: rendered({}),
    expectations: Schemas.getCommitCheckExpectations(readbackOp, args, BEFORE),
  };
}

let host: FakeHost;
let waits: number[];
let token: string | null;

function adapter(overrides: Partial<Schemas.HostConnection> = {}): Schemas.HostAdapter {
  const created = RestAdapter.create({
    connection: { ...connection, ...overrides },
    getHostToken: () => token,
    fetch: host.fetch,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  if (!created.adapter) throw new Error(created.message);
  return created.adapter;
}

function commit(
  mode: Schemas.ToolDefinitionIdempotencyModeIntEnum,
  overrides: Partial<Schemas.HostWriteCall> = {},
): Schemas.HostExecuteCall {
  return {
    risk: Schemas.ToolDefinitionRiskIntEnum.Write,
    request: commitRequest,
    idempotencyMode: mode,
    idempotencyKey: "cr_01J9ZK:commit",
    appliedCheck:
      mode === Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated
        ? appliedCheck({ amount: 12.5 })
        : null,
    isResume: false,
    ...overrides,
  };
}

beforeEach(() => {
  host = new FakeHost();
  waits = [];
  token = TOKEN;
});

describe("RestAdapter.create", () => {
  it("refuses a connection it can't call", () => {
    const create = (overrides: Partial<Schemas.HostConnection>) =>
      RestAdapter.create({
        connection: { ...connection, ...overrides },
        getHostToken: () => TOKEN,
      });
    expect(create({ adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.Mcp }).message).toBe(
      "Connection is not a REST connection",
    );
    expect(create({ baseUrl: null }).message).toBe("Connection has no base URL");
    expect(create({ baseUrl: "http://host.example.com" }).message).toBe(
      "Base URL must be https with no query or credentials",
    );
    expect(create({ authType: Schemas.CompanyConnectionAuthTypeEnum.ApiKeyHeader }).message).toBe(
      "Auth type api_key_header is not supported yet",
    );
    expect(create({ authConfig: { header: "X" } }).isSuccess).toBe(false);
    expect(create({}).isSuccess).toBe(true);
  });
});

describe("RestAdapter reads", () => {
  const read = (request: Partial<Schemas.RenderedToolRequest> = {}): Schemas.HostExecuteCall => ({
    risk: Schemas.ToolDefinitionRiskIntEnum.Read,
    request: rendered(request),
  });

  it("calls base_url + path as the user, with the query, never following redirects", async () => {
    const response = await adapter().execute(read({ query: { view: "full", q: "a b" } }));
    expect(response).toMatchObject({
      isSuccess: true,
      outcome: Schemas.HostCallOutcomeEnum.Succeeded,
      httpStatus: 200,
      body: { data: { amount: 10 } },
      attempts: 1,
    });
    const [request] = host.requests;
    expect(request!.url).toBe("https://host.example.com/v1/records/r1?view=full&q=a+b");
    expect(request!.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request!.headers.get("Accept")).toBe("application/json");
    expect(request!.headers.has(Schemas.HOST_IDEMPOTENCY_KEY_HEADER)).toBe(false);
    expect(request!.redirect).toBe("manual");
  });

  it("retries 5xx, 408, 429 and no answer, honouring Retry-After (capped)", async () => {
    host.faults = [
      { kind: "status", status: 503, headers: { "Retry-After": "2" } },
      { kind: "status", status: 429, headers: { "Retry-After": "3600" } },
    ];
    const response = await adapter().execute(read());
    expect(response.outcome).toBe(Schemas.HostCallOutcomeEnum.Succeeded);
    expect(response.attempts).toBe(3);
    expect(waits).toEqual([2_000, Schemas.HOST_CALL_RETRY_AFTER_MAX_MS]);

    host.faults = [{ kind: "drop" }, { kind: "status", status: 408 }];
    waits = [];
    expect((await adapter().execute(read())).attempts).toBe(3);
    expect(waits).toEqual([Schemas.HOST_CALL_RETRY_BASE_MS, Schemas.HOST_CALL_RETRY_BASE_MS * 2]);
  });

  it("gives up after HOST_CALL_MAX_RETRIES", async () => {
    host.faults = [{ kind: "drop" }, { kind: "drop" }, { kind: "drop" }];
    const response = await adapter().execute(read());
    expect(response).toMatchObject({
      isSuccess: false,
      outcome: Schemas.HostCallOutcomeEnum.Failed,
      message: "Host didn't answer",
      attempts: Schemas.HOST_CALL_MAX_RETRIES + 1,
    });
  });

  it("maps 4xx, 401 and 3xx without retrying", async () => {
    expect(await adapter().execute(read({ path: "/records/missing" }))).toMatchObject({
      outcome: Schemas.HostCallOutcomeEnum.Refused,
      httpStatus: 404,
      attempts: 1,
    });
    host.faults = [{ kind: "status", status: 401 }];
    expect((await adapter().execute(read())).outcome).toBe(
      Schemas.HostCallOutcomeEnum.TokenRejected,
    );
    host.faults = [{ kind: "status", status: 302, headers: { Location: "https://evil.example" } }];
    expect(await adapter().execute(read())).toMatchObject({
      outcome: Schemas.HostCallOutcomeEnum.Failed,
      message: "Host redirect not followed",
    });
    expect(host.requests).toHaveLength(3);
  });

  it("fails on a body that isn't JSON or is over the size cap", async () => {
    host.faults = [{ kind: "status", status: 200, body: "<html>" }];
    expect((await adapter().execute(read())).message).toBe("Host response is unreadable");
    host.faults = [
      { kind: "status", status: 200, body: `"${"x".repeat(Schemas.HOST_RESPONSE_MAX_BYTES)}"` },
    ];
    expect((await adapter().execute(read())).message).toBe("Host response is unreadable");
    host.faults = [{ kind: "status", status: 204 }];
    expect(await adapter().execute(read())).toMatchObject({ isSuccess: true, body: null });
  });

  it("sends nothing without a usable token", async () => {
    token = null;
    expect((await adapter().execute(read())).outcome).toBe(Schemas.HostCallOutcomeEnum.TokenNeeded);
    token = "abc\r\nX-Injected: 1";
    const rejected = await adapter().execute(read());
    expect(rejected.outcome).toBe(Schemas.HostCallOutcomeEnum.TokenRejected);
    expect(rejected.message).not.toContain("abc");
    expect(host.requests).toHaveLength(0);
  });

  it("keeps every call under base_url", async () => {
    for (const path of ["/records/%2e%2e/admin", "//evil.example/x", "records"]) {
      const response = await adapter().execute(read({ path }));
      expect(response.outcome).toBe(Schemas.HostCallOutcomeEnum.Failed);
    }
    expect((await adapter().execute(read({ body: { a: 1 } }))).message).toBe("A GET has no body");
    expect(host.requests).toHaveLength(0);
  });

  it("stops on the caller's abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await adapter().execute({ ...read(), signal: controller.signal });
    expect(response).toMatchObject({ outcome: Schemas.HostCallOutcomeEnum.Failed, attempts: 0 });
  });

  it("readback is a GET only", async () => {
    const response = await adapter().readback({ request: commitRequest });
    expect(response.message).toBe("A readback is a GET");
    expect(host.requests).toHaveLength(0);
  });
});

describe("Retried commit never writes twice", () => {
  describe("Native", () => {
    const native = Schemas.ToolDefinitionIdempotencyModeIntEnum.Native;

    it("resends a commit whose answer was lost with the same key; the host runs it once", async () => {
      host.faults = [{ kind: "applyThenDrop" }, { kind: "status", status: 503 }];
      const response = await adapter().execute(commit(native));
      expect(response).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Succeeded,
        body: { data: { amount: 12.5 } },
        attempts: 3,
        mayHaveLanded: true,
      });
      expect(host.appliedWrites).toBe(1);
      expect(
        host.writes().map((request) => request.headers.get(Schemas.HOST_IDEMPOTENCY_KEY_HEADER)),
      ).toEqual(["cr_01J9ZK:commit", "cr_01J9ZK:commit", "cr_01J9ZK:commit"]);
    });

    it("retries a 409 (same key still running)", async () => {
      host.faults = [{ kind: "status", status: 409 }];
      expect((await adapter().execute(commit(native))).outcome).toBe(
        Schemas.HostCallOutcomeEnum.Succeeded,
      );
    });

    it("returns Unknown when retries run out, and a resume still writes once", async () => {
      host.faults = [{ kind: "applyThenDrop" }, { kind: "drop" }, { kind: "drop" }];
      const first = await adapter().execute(commit(native));
      expect(first).toMatchObject({
        isSuccess: false,
        outcome: Schemas.HostCallOutcomeEnum.Unknown,
        mayHaveLanded: true,
      });

      const resumed = await adapter().execute(commit(native, { isResume: true }));
      expect(resumed.outcome).toBe(Schemas.HostCallOutcomeEnum.Succeeded);
      expect(host.appliedWrites).toBe(1);
    });

    it("refuses an invalid key without sending", async () => {
      const response = await adapter().execute(commit(native, { idempotencyKey: "has space" }));
      expect(response.message).toBe("Invalid idempotency key");
      expect(host.requests).toHaveLength(0);
    });
  });

  describe("Emulated", () => {
    const emulated = Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated;

    beforeEach(() => {
      host.supportsIdempotencyKey = false;
    });

    it("reads back before resending: a commit that landed is AlreadyApplied, not sent again", async () => {
      host.faults = [{ kind: "applyThenDrop" }];
      const response = await adapter().execute(commit(emulated));
      expect(response).toMatchObject({
        isSuccess: true,
        outcome: Schemas.HostCallOutcomeEnum.AlreadyApplied,
        attempts: 1,
        mayHaveLanded: true,
      });
      expect(host.appliedWrites).toBe(1);
      expect(host.writes()).toHaveLength(1);
      expect(host.writes()[0]!.headers.has(Schemas.HOST_IDEMPOTENCY_KEY_HEADER)).toBe(false);
    });

    it("resends a commit the readback shows didn't land", async () => {
      host.faults = [{ kind: "drop" }];
      const response = await adapter().execute(commit(emulated));
      expect(response).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Succeeded,
        attempts: 2,
      });
      expect(host.appliedWrites).toBe(1);
    });

    it("on resume, checks first: landed → no send, not landed → send", async () => {
      host.records.get("r1")!.amount = 12.5;
      const landed = await adapter().execute(commit(emulated, { isResume: true }));
      expect(landed).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.AlreadyApplied,
        attempts: 0,
      });
      expect(host.writes()).toHaveLength(0);

      host.records.get("r1")!.amount = 10;
      const notLanded = await adapter().execute(commit(emulated, { isResume: true }));
      expect(notLanded).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Succeeded,
        attempts: 1,
      });
      expect(host.appliedWrites).toBe(1);
    });

    it("never resends when the readback can't tell", async () => {
      host.faults = [
        { kind: "applyThenDrop" },
        { kind: "status", status: 500 },
        { kind: "status", status: 500 },
        { kind: "status", status: 500 },
      ];
      const response = await adapter().execute(commit(emulated));
      expect(response).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Unknown,
        mayHaveLanded: true,
      });
      expect(host.writes()).toHaveLength(1);
      expect(host.appliedWrites).toBe(1);

      const empty = await adapter().execute(
        commit(emulated, { isResume: true, appliedCheck: appliedCheck({}) }),
      );
      expect(empty).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Unknown,
        message: "Nothing to compare the readback with",
      });
      expect(host.writes()).toHaveLength(1);
    });

    it("never resends a write that landed but reads back in another form", async () => {
      // DEV_NOTE: The host lowercases emails: the readback shows neither the sent nor the earlier value
      host.store = (body) => ({ ...body, email: String(body.email).toLowerCase() });
      host.faults = [{ kind: "applyThenDrop" }];
      const response = await adapter().execute(
        commit(emulated, {
          request: rendered({
            method: Schemas.ToolOpMethodEnum.Patch,
            body: { email: "Bob@x.com" },
          }),
          appliedCheck: appliedCheck({ email: "Bob@x.com" }),
        }),
      );
      expect(response).toMatchObject({
        isSuccess: false,
        outcome: Schemas.HostCallOutcomeEnum.Unknown,
        message: "Readback matches neither the written nor the earlier values",
        mayHaveLanded: true,
      });
      expect(host.writes()).toHaveLength(1);
      expect(host.appliedWrites).toBe(1);
    });

    it("checks the last uncertain attempt too: landed then → AlreadyApplied", async () => {
      // DEV_NOTE: Every request takes the next fault: each lost write is followed by its readback check
      host.faults = [
        { kind: "drop" },
        { kind: "none" },
        { kind: "drop" },
        { kind: "none" },
        { kind: "applyThenDrop" },
      ];
      const response = await adapter().execute(commit(emulated));
      expect(response).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.AlreadyApplied,
        attempts: 3,
      });
      expect(host.reads()).toHaveLength(3);
      expect(host.appliedWrites).toBe(1);
    });

    it("fails, not Unknown, when every attempt failed and the last check shows nothing landed", async () => {
      // DEV_NOTE: Every request takes the next fault: each 503 write is followed by its readback check
      host.faults = [
        { kind: "status", status: 503 },
        { kind: "none" },
        { kind: "status", status: 503 },
        { kind: "none" },
        { kind: "status", status: 503 },
      ];
      const response = await adapter().execute(commit(emulated));
      expect(response).toMatchObject({
        isSuccess: false,
        outcome: Schemas.HostCallOutcomeEnum.Failed,
        attempts: 3,
        mayHaveLanded: false,
      });
      expect(host.reads()).toHaveLength(3);
      expect(host.appliedWrites).toBe(0);
    });

    it("passes on a missing token during the check, still marked as possibly landed", async () => {
      host.faults = [{ kind: "drop" }];
      let calls = 0;
      const created = RestAdapter.create({
        connection,
        getHostToken: () => (calls++ === 0 ? TOKEN : null),
        fetch: host.fetch,
        wait: async () => {},
      });
      const response = await created.adapter!.execute(commit(emulated));
      expect(response).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.TokenNeeded,
        mayHaveLanded: true,
      });
    });

    it("needs a GET readback check", async () => {
      expect((await adapter().execute(commit(emulated, { appliedCheck: null }))).message).toBe(
        "Emulated idempotency needs a readback check",
      );
      const postCheck = { ...appliedCheck({ amount: 1 }), request: commitRequest };
      expect((await adapter().execute(commit(emulated, { appliedCheck: postCheck }))).message).toBe(
        "A readback is a GET",
      );
      expect(host.requests).toHaveLength(0);
    });
  });

  describe("None", () => {
    const none = Schemas.ToolDefinitionIdempotencyModeIntEnum.None;

    beforeEach(() => {
      host.supportsIdempotencyKey = false;
    });

    it("never resends a write that may have landed", async () => {
      host.faults = [{ kind: "applyThenDrop" }];
      expect(await adapter().execute(commit(none))).toMatchObject({
        isSuccess: false,
        outcome: Schemas.HostCallOutcomeEnum.Unknown,
        attempts: 1,
        mayHaveLanded: true,
      });
      host.faults = [{ kind: "status", status: 502 }];
      expect((await adapter().execute(commit(none))).outcome).toBe(
        Schemas.HostCallOutcomeEnum.Unknown,
      );
      expect(host.writes()).toHaveLength(2);
      expect(host.appliedWrites).toBe(1);
    });

    it("resends only after a 429", async () => {
      host.faults = [{ kind: "status", status: 429 }];
      expect(await adapter().execute(commit(none))).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Succeeded,
        attempts: 2,
      });
      expect(host.appliedWrites).toBe(1);
    });

    it("never sends on resume", async () => {
      expect(await adapter().execute(commit(none, { isResume: true }))).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Unknown,
        attempts: 0,
        mayHaveLanded: true,
      });
      expect(host.requests).toHaveLength(0);
    });

    it("maps a refusal and a redirect", async () => {
      host.faults = [{ kind: "status", status: 422 }];
      expect(await adapter().execute(commit(none))).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Refused,
        httpStatus: 422,
        mayHaveLanded: false,
      });
      host.faults = [{ kind: "status", status: 303, headers: { Location: "/records/r1" } }];
      expect(await adapter().execute(commit(none))).toMatchObject({
        outcome: Schemas.HostCallOutcomeEnum.Unknown,
        mayHaveLanded: true,
      });
      expect(host.requests).toHaveLength(2);
    });

    it("counts a 2xx write with an unreadable body as landed", async () => {
      host.faults = [{ kind: "status", status: 201, body: "created" }];
      const response = await adapter().execute(commit(none));
      expect(response).toMatchObject({ isSuccess: true, httpStatus: 201 });
      expect(response.body).toBeUndefined();
    });

    it("returns Unknown when the caller aborts mid-call", async () => {
      const controller = new AbortController();
      const abortingHost: typeof fetch = async () => {
        controller.abort();
        throw new DOMException("Aborted", "AbortError");
      };
      const created = RestAdapter.create({
        connection,
        getHostToken: () => TOKEN,
        fetch: abortingHost,
      });
      expect(
        await created.adapter!.execute(commit(none, { signal: controller.signal })),
      ).toMatchObject({ outcome: Schemas.HostCallOutcomeEnum.Unknown, mayHaveLanded: true });
    });
  });
});

describe("RestAdapter.undo", () => {
  it("emulated: an undo that landed is AlreadyApplied against the before values", async () => {
    host.supportsIdempotencyKey = false;
    host.records.get("r1")!.amount = 12.5;
    host.faults = [{ kind: "applyThenDrop" }];
    const response = await adapter().undo({
      request: rendered({ method: Schemas.ToolOpMethodEnum.Patch, body: { amount: 10 } }),
      idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated,
      idempotencyKey: "cr_01J9ZK:undo",
      appliedCheck: {
        request: rendered({}),
        expectations: Schemas.getUndoCheckExpectations(readbackOp, { amount: 12.5 }, BEFORE),
      },
      isResume: false,
    });
    expect(response.outcome).toBe(Schemas.HostCallOutcomeEnum.AlreadyApplied);
    expect(host.records.get("r1")!.amount).toBe(10);
    expect(host.appliedWrites).toBe(1);
  });
});

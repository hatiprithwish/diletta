import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import app from "@/index";
import * as Schemas from "@app/schemas";
import {
  adminHeaders,
  api,
  mintTokens,
  newWorkspace,
  readRecord,
  setFaults,
} from "@/tests/helpers";

let workspace = "";
let token = "";

beforeEach(async () => {
  workspace = newWorkspace();
  token = (await mintTokens(workspace)).hostToken;
  await api("POST", "/v1/_reset", { token });
});

const patchAlpha = (amount: number, idempotencyKey?: string) =>
  api("PATCH", "/v1/records/rec_alpha", {
    token,
    body: { amount },
    ...(idempotencyKey && { idempotencyKey }),
  });

describe("fault control", () => {
  it("is admin only and validates the faults", async () => {
    const path = `/control/workspaces/${workspace}/faults`;
    const body = JSON.stringify({ faults: [] });
    expect((await app.request(path, { method: "PUT", body }, env)).status).toBe(401);
    expect(
      (
        await app.request(
          path,
          {
            method: "PUT",
            headers: adminHeaders(),
            body: JSON.stringify({ faults: [{ kind: "status", status: 200, isApplied: false }] }),
          },
          env,
        )
      ).status,
    ).toBe(400);
  });

  it("uses each fault once, first match in order, and reports what is left", async () => {
    await setFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 500,
        isApplied: false,
        method: Schemas.ToolOpMethodEnum.Post,
      },
      { kind: Schemas.TestHostFaultKindEnum.Status, status: 503, isApplied: false },
    ]);
    expect((await api("GET", "/v1/records/rec_alpha", { token })).status).toBe(503);
    expect((await api("GET", "/v1/records/rec_alpha", { token })).status).toBe(200);

    const left = await app.request(
      `/control/workspaces/${workspace}/faults`,
      { headers: adminHeaders() },
      env,
    );
    expect(Schemas.ZTestHostSetFaultsRequest.parse(await left.json()).faults).toEqual([
      { kind: "status", status: 500, isApplied: false, method: "POST" },
    ]);
  });
});

describe("faults", () => {
  it("refuses before applying, with Retry-After", async () => {
    await setFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 429,
        isApplied: false,
        retryAfterSeconds: 2,
      },
    ]);
    const response = await patchAlpha(1);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect((await readRecord(token, "rec_alpha"))?.amount).toBe(120);
  });

  it("applies and then loses the answer; a keyed resend gets the stored answer", async () => {
    await setFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 503,
        isApplied: true,
        path: "/v1/records",
      },
    ]);
    const body = { name: "Lost", email: "l@x.co", amount: 9 };
    const lost = await api("POST", "/v1/records", { token, body, idempotencyKey: "k-lost" });
    expect(lost.status).toBe(503);

    const resent = await api("POST", "/v1/records", { token, body, idempotencyKey: "k-lost" });
    expect(resent.status).toBe(201);
    const list = await api("GET", "/v1/records", { token });
    const names = Schemas.ZTestHostRecordListResponse.parse(await list.json()).data.map(
      (record) => record.name,
    );
    expect(names.filter((name) => name === "Lost")).toHaveLength(1);
  });

  it("overwrites the touched record after a write (a concurrent edit)", async () => {
    await setFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Overwrite,
        fields: { amount: 999, email: "Someone@Else.CO" },
      },
    ]);
    const response = await patchAlpha(5);
    expect(Schemas.ZTestHostRecordResponse.parse(await response.json()).data.amount).toBe(5);
    expect(await readRecord(token, "rec_alpha")).toMatchObject({
      amount: 999,
      email: "someone@else.co",
    });

    await setFaults(workspace, [
      { kind: Schemas.TestHostFaultKindEnum.Overwrite, fields: { amount: 1 } },
    ]);
    const created = await api("POST", "/v1/records", {
      token,
      body: { name: "New", email: "n@x.co", amount: 2 },
    });
    const { id } = Schemas.ZTestHostRecordResponse.parse(await created.json()).data;
    expect((await readRecord(token, id))?.amount).toBe(1);
  });

  it("overwrites nothing after a refused or replayed write, or a read", async () => {
    const overwrite: Schemas.TestHostFault = {
      kind: Schemas.TestHostFaultKindEnum.Overwrite,
      fields: { amount: 777 },
    };

    // Same key, other body: 422, nothing ran
    await patchAlpha(10, "k-once");
    await setFaults(workspace, [overwrite]);
    expect((await patchAlpha(11, "k-once")).status).toBe(422);
    expect((await readRecord(token, "rec_alpha"))?.amount).toBe(10);

    // Same key, same body: the stored answer is replayed, nothing ran
    await setFaults(workspace, [overwrite]);
    expect((await patchAlpha(10, "k-once")).status).toBe(200);
    expect((await readRecord(token, "rec_alpha"))?.amount).toBe(10);

    // An unfiltered fault taken by a read
    await setFaults(workspace, [overwrite]);
    expect((await api("GET", "/v1/records/rec_alpha", { token })).status).toBe(200);
    expect((await readRecord(token, "rec_alpha"))?.amount).toBe(10);
  });

  it("holds the answer for a delay, after applying", async () => {
    await setFaults(workspace, [{ kind: Schemas.TestHostFaultKindEnum.Delay, ms: 50 }]);
    const started = Date.now();
    expect((await patchAlpha(3)).status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("reset clears faults and stored keys", async () => {
    await patchAlpha(4, "k-reset");
    await setFaults(workspace, [
      { kind: Schemas.TestHostFaultKindEnum.Status, status: 500, isApplied: false },
    ]);
    await setFaults(workspace, []);
    await setFaults(workspace, [
      {
        kind: Schemas.TestHostFaultKindEnum.Status,
        status: 500,
        isApplied: false,
        method: Schemas.ToolOpMethodEnum.Delete,
      },
    ]);
    await api("POST", "/v1/_reset", { token });
    expect((await api("DELETE", "/v1/records/rec_alpha", { token })).status).toBe(204);
    // The key's earlier answer is gone, so the same key with another body runs
    expect((await patchAlpha(8, "k-reset")).status).toBe(404);
  });
});

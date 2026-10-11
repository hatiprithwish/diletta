import { describe, it, expect, beforeEach } from "vitest";
import * as Schemas from "@app/schemas";
import { api, mintTokens, newWorkspace, readRecord } from "@/tests/helpers";

let token = "";

beforeEach(async () => {
  token = (await mintTokens(newWorkspace())).hostToken;
});

const create = async (body: unknown, idempotencyKey?: string) =>
  api("POST", "/v1/records", { token, body, ...(idempotencyKey && { idempotencyKey }) });

describe("records", () => {
  it("starts empty and resets to the seed records", async () => {
    const empty = await api("GET", "/v1/records", { token });
    expect(Schemas.ZTestHostRecordListResponse.parse(await empty.json()).data).toEqual([]);

    const reset = await api("POST", "/v1/_reset", { token });
    expect(reset.status).toBe(200);
    const list = await api("GET", "/v1/records", { token });
    expect(Schemas.ZTestHostRecordListResponse.parse(await list.json()).data).toEqual(
      [...Schemas.TEST_HOST_SEED_RECORDS].sort((a, b) => a.id.localeCompare(b.id)),
    );

    const active = await api("GET", "/v1/records?status=archived&limit=5", { token });
    expect(
      Schemas.ZTestHostRecordListResponse.parse(await active.json()).data.map(({ id }) => id),
    ).toEqual(["rec_charlie"]);
    expect((await api("GET", "/v1/records?limit=0", { token })).status).toBe(400);
  });

  it("creates, reads, updates, replaces and deletes, storing email lowercased", async () => {
    const created = await create({ name: "Delta", email: "Ops@Delta.Example", amount: 5 });
    expect(created.status).toBe(201);
    const record = Schemas.ZTestHostRecordResponse.parse(await created.json()).data;
    expect(record).toMatchObject({
      name: "Delta",
      email: "ops@delta.example",
      amount: 5,
      status: Schemas.TestHostRecordStatusEnum.Active,
    });
    expect(await readRecord(token, record.id)).toEqual(record);

    const patched = await api("PATCH", `/v1/records/${record.id}`, {
      token,
      body: { amount: 7.25, status: "archived" },
    });
    expect(patched.status).toBe(200);
    expect(await readRecord(token, record.id)).toMatchObject({ amount: 7.25, status: "archived" });

    expect((await api("DELETE", `/v1/records/${record.id}`, { token })).status).toBe(204);
    expect(await readRecord(token, record.id)).toBeNull();
    expect((await api("DELETE", `/v1/records/${record.id}`, { token })).status).toBe(404);

    // Undo of a delete: PUT the record back under its id
    const restored = await api("PUT", `/v1/records/${record.id}`, {
      token,
      body: { name: "Delta", email: "ops@delta.example", amount: 5, status: "active" },
    });
    expect(restored.status).toBe(201);
    expect(await readRecord(token, record.id)).toEqual(record);
    const replaced = await api("PUT", `/v1/records/${record.id}`, {
      token,
      body: { name: "Delta 2", email: "ops@delta.example", amount: 5 },
    });
    expect(replaced.status).toBe(200);
  });

  it("refuses invalid bodies, ids and missing records", async () => {
    expect((await create({ name: "x", email: "not-an-email", amount: 1 })).status).toBe(400);
    expect((await create({ name: "x", email: "a@b.co", amount: 1, extra: true })).status).toBe(400);
    expect((await api("PATCH", "/v1/records/rec_alpha", { token, body: {} })).status).toBe(400);
    expect((await api("GET", "/v1/records/bad%20id", { token })).status).toBe(400);
    expect((await api("GET", "/v1/records/rec_missing", { token })).status).toBe(404);
    expect(
      (await api("PATCH", "/v1/records/rec_missing", { token, body: { amount: 1 } })).status,
    ).toBe(404);
    const malformed = await api("POST", "/v1/records", { token, body: undefined });
    expect(malformed.status).toBe(400);
  });

  it("keeps workspaces apart", async () => {
    const other = (await mintTokens(newWorkspace())).hostToken;
    const created = await create({ name: "Mine", email: "me@x.co", amount: 1 });
    const { id } = Schemas.ZTestHostRecordResponse.parse(await created.json()).data;
    expect(await readRecord(other, id)).toBeNull();
    await api("POST", "/v1/_reset", { token: other });
    expect(await readRecord(token, id)).not.toBeNull();
    expect(await readRecord(token, "rec_alpha")).toBeNull();
  });
});

describe("Idempotency-Key", () => {
  it("runs a keyed write once and replays its answer", async () => {
    const body = { name: "Echo", email: "e@x.co", amount: 3 };
    const first = await create(body, "key-1");
    const second = await create(body, "key-1");
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());

    const list = await api("GET", "/v1/records", { token });
    expect(Schemas.ZTestHostRecordListResponse.parse(await list.json()).data).toHaveLength(1);
  });

  it("refuses a key reused for another request, and a malformed key", async () => {
    await create({ name: "Echo", email: "e@x.co", amount: 3 }, "key-2");
    const reused = await create({ name: "Echo", email: "e@x.co", amount: 4 }, "key-2");
    expect(reused.status).toBe(422);
    expect((await create({ name: "F", email: "f@x.co", amount: 1 }, "has space")).status).toBe(400);
  });

  it("applies to PATCH and DELETE too, and an unkeyed write runs every time", async () => {
    await api("POST", "/v1/_reset", { token });
    const patch = () =>
      api("PATCH", "/v1/records/rec_alpha", {
        token,
        body: { amount: 1 },
        idempotencyKey: "patch-1",
      });
    expect((await patch()).status).toBe(200);
    await api("PATCH", "/v1/records/rec_alpha", { token, body: { amount: 2 } });
    expect((await patch()).status).toBe(200);
    expect((await readRecord(token, "rec_alpha"))?.amount).toBe(2);

    const remove = () =>
      api("DELETE", "/v1/records/rec_bravo", { token, idempotencyKey: "delete-1" });
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(204);
  });
});

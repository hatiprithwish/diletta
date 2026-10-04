import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as Schemas from "@app/schemas";
import worker from "../index";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// DEV_NOTE: Tests hit the Neon staging branch. A unique user per run isolates rows; each test deletes what it creates.
const TEST_USER_ID = `user_test_${crypto.randomUUID()}`;

const mockAuthenticateRequest = vi.fn().mockResolvedValue({
  isSignedIn: true,
  reason: null,
  toAuth: () => ({
    userId: TEST_USER_ID,
    sessionClaims: { email: "test@example.com" },
  }),
});

// Mock Clerk authentication — real token verification needs network + valid keys
vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: () => ({
      authenticateRequest: mockAuthenticateRequest,
    }),
  },
}));

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

function makeRequest(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Notes routes (authenticated)", () => {
  let ctx: ExecutionContext;

  beforeEach(() => {
    ctx = createExecutionContext();
    mockAuthenticateRequest.mockResolvedValue({
      isSignedIn: true,
      reason: null,
      toAuth: () => ({
        userId: TEST_USER_ID,
        sessionClaims: { email: "test@example.com" },
      }),
    });
  });

  it("GET /notes returns 200", async () => {
    const req = makeRequest("/notes");
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
  });

  it("POST /notes with valid body returns 201", async () => {
    const req = makeRequest("/notes", "POST", {
      note: { title: "Test note", body: "Hello world" },
    });
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(201);

    const { note } = await res.json<Schemas.CreateNoteApiResponse>();
    const cleanupRes = await worker.fetch(
      makeRequest(`/notes/${note?.publicId}`, "DELETE"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(cleanupRes.status).toBe(200);
  });

  it("creates, reads, updates and deletes a note on Postgres", async () => {
    const send = async (path: string, method = "GET", body?: unknown) => {
      const res = await worker.fetch(makeRequest(path, method, body), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    const createRes = await send("/notes", "POST", {
      note: { title: "Postgres note", body: "First body" },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<Schemas.CreateNoteApiResponse>();
    const publicId = created.note?.publicId;
    expect(publicId).toBeTruthy();
    expect(created.note).not.toHaveProperty("id");
    expect(created.note?.noteStatusLabel).toBe("Draft");
    expect(created.note?.updatedAt).toBeTruthy();

    const listRes = await send("/notes");
    expect(listRes.status).toBe(200);
    const listed = await listRes.json<Schemas.GetNotesApiResponse>();
    expect(listed.notes?.some((note) => note.publicId === publicId)).toBe(true);

    // Partial update: omitted body is left unchanged
    const updateRes = await send(`/notes/${publicId}`, "PATCH", {
      note: { title: "Updated title" },
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json<Schemas.UpdateNoteApiResponse>();
    expect(updated.note).not.toHaveProperty("id");
    expect(updated.note?.title).toBe("Updated title");
    expect(updated.note?.body).toBe("First body");

    // Explicit null clears body
    const clearRes = await send(`/notes/${publicId}`, "PATCH", { note: { body: null } });
    expect(clearRes.status).toBe(200);
    const cleared = await clearRes.json<Schemas.UpdateNoteApiResponse>();
    expect(cleared.note?.title).toBe("Updated title");
    expect(cleared.note?.body).toBeNull();

    const deleteRes = await send(`/notes/${publicId}`, "DELETE");
    expect(deleteRes.status).toBe(200);

    const getRes = await send(`/notes/${publicId}`);
    expect(getRes.status).toBe(404);
  });

  it("PATCH /notes/:publicId for a missing note returns 404", async () => {
    const req = makeRequest("/notes/does-not-exist", "PATCH", { note: { title: "x" } });
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });
});

describe("Unauthenticated requests", () => {
  it("GET /notes without auth returns 401", async () => {
    mockAuthenticateRequest.mockResolvedValueOnce({
      isSignedIn: false,
      reason: "no-token",
      toAuth: () => null,
    });

    const ctx = createExecutionContext();
    const req = makeRequest("/notes");
    const res = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(401);
  });
});

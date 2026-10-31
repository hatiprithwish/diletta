import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, like, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { evalCases } from "@/db/tables";
import AppLogger from "@/providers/logger";
import PlatformEvalCaseSyncProvider from "@/providers/platformEvalCaseSync";
import PlatformEvalCasesRepo from "@/repositories/PlatformEvalCasesRepo";
import Utility from "@/utils/Utility";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: The platform suite's case sync (M5-5) on the Neon staging branch, as diletta_app in withPlatform (the role and
// transaction the cron uses). Staging is shared, so these tests never write the real cases: the sync runs over definitions
// of its own under TEST_KEY_PREFIX, never a safety case (the CHECK would keep it active for other suites), and each test
// ends with its rows off. An eval run another suite starts while a row is on holds it in its case set until it finishes,
// so afterAll (as the owner: no company cleanup reaches a platform row) deletes only rows older than ROW_MAX_AGE_MS, this
// run's included on the next one. What the sync decides for safety cases is the pure plan's, in
// platformEvalCaseSyncProvider.test.ts.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const TEST_KEY_PREFIX = `test.sync_${crypto.randomUUID().slice(0, 8)}`;
const ROW_MAX_AGE_MS = 60 * 60_000;
let ownerPool: Pool;
let ownerDb: NodePgDatabase;

const definition = (
  suffix: string,
  overrides: Partial<Schemas.PlatformEvalCaseDefinition> = {},
): Schemas.PlatformEvalCaseDefinition => ({
  platformKey: `${TEST_KEY_PREFIX}.${suffix}`,
  name: `Sync test ${suffix}`,
  isSafety: false,
  body: {
    messages: [{ role: Schemas.EvalCaseMessageRoleEnum.User, text: "Hello?" }],
    rubric: "Greets the user.",
    checks: Schemas.EVAL_CASE_NO_CHECKS,
  },
  ...overrides,
});

const sync = async (definitions: Schemas.PlatformEvalCaseDefinition[]) =>
  await new PlatformEvalCasesRepo(env).sync({ definitions, keyPrefix: TEST_KEY_PREFIX });

async function stored(suffix: string) {
  const [row] = await ownerDb
    .select()
    .from(evalCases)
    .where(eq(evalCases.platformKey, `${TEST_KEY_PREFIX}.${suffix}`));
  return row;
}

beforeAll(async () => {
  ownerPool = new Pool({ connectionString: ownerDatabaseUrl, max: 2 });
  ownerDb = drizzle({ client: ownerPool });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  try {
    const conditions = [
      like(evalCases.platformKey, "test.sync\\_%"),
      lt(evalCases.createdAt, new Date(Date.now() - ROW_MAX_AGE_MS)),
    ];
    await ownerDb.delete(evalCases).where(and(...conditions));
  } finally {
    await ownerPool.end();
  }
});

describe("PlatformEvalCasesRepo.sync", () => {
  afterEach(async () => {
    await sync([]);
  });

  it("writes a new case active, and changes nothing on a rerun", async () => {
    const created = await sync([definition("new")]);
    expect(created).toMatchObject({ isSuccess: true, createdCount: 1, updatedCount: 0 });
    const row = await stored("new");
    expect(row).toMatchObject({ companyId: null, chatbotId: null, isActive: true });
    expect(Schemas.readEvalCaseBody(row?.input, row?.expectations)).not.toBeNull();

    // DEV_NOTE: jsonb reorders keys; the compare doesn't see that as a change
    const rerun = await sync([definition("new")]);
    expect(rerun).toMatchObject({
      isSuccess: true,
      createdCount: 0,
      updatedCount: 0,
      deactivatedCount: 0,
      keptSafetyKeys: [],
    });
    expect((await stored("new"))?.updatedAt).toEqual(row?.updatedAt);
  });

  it("rewrites a case edited outside the code back to the code's", async () => {
    await sync([definition("edited")]);
    await ownerDb
      .update(evalCases)
      .set({ name: "Edited by hand" })
      .where(eq(evalCases.platformKey, `${TEST_KEY_PREFIX}.edited`));

    expect(await sync([definition("edited")])).toMatchObject({ isSuccess: true, updatedCount: 1 });
    expect((await stored("edited"))?.name).toBe("Sync test edited");
  });

  it("turns off a keyed case no longer in code, and turns it on again when it comes back", async () => {
    await sync([definition("removed"), definition("kept")]);

    expect(await sync([definition("kept")])).toMatchObject({
      isSuccess: true,
      deactivatedCount: 1,
    });
    expect((await stored("removed"))?.isActive).toBe(false);
    expect((await stored("kept"))?.isActive).toBe(true);

    expect(await sync([definition("removed"), definition("kept")])).toMatchObject({
      updatedCount: 1,
    });
    expect((await stored("removed"))?.isActive).toBe(true);
  });

  it("writes nothing when one case in the list is bad", async () => {
    const synced = await sync([
      definition("good"),
      definition("bad", { body: { ...definition("bad").body, rubric: null } }),
    ]);
    expect(synced.isSuccess).toBe(false);
    expect(await stored("good")).toBeUndefined();
  });

  it("alerts on what the plan kept", async () => {
    vi.spyOn(PlatformEvalCaseSyncProvider, "plan").mockReturnValueOnce({
      create: [],
      update: [],
      deactivateIds: [],
      keptSafetyKeys: ["safety.retired"],
    });
    const synced = await sync([]);
    expect(synced).toMatchObject({ isSuccess: true, keptSafetyKeys: ["safety.retired"] });
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        action: Schemas.LogAction.SyncPlatformEvalCases,
        message: "Platform safety cases removed or demoted in code are still active",
      }),
    );
  });

  it("refuses a key on a company's case", async () => {
    const refused = ownerDb.insert(evalCases).values({
      publicId: Utility.generatePublicId(),
      companyId: "1",
      chatbotId: "1",
      platformKey: `${TEST_KEY_PREFIX}.company`,
      name: "A company's case",
      input: {},
      expectations: {},
    });
    await expect(refused).rejects.toMatchObject({
      cause: { constraint: "CHK_eval_cases_platform_key" },
    });
  });
});

import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { evalCases } from "@/db/tables";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import AppLogger from "@/providers/logger";
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

// DEV_NOTE: The platform suite's case sync (M5-5) on the Neon staging branch, as diletta_app in withPlatform (the role
// and transaction the cron uses). Its real cases are what every deploy writes to staging anyway, so they are left in
// place. The rows a test adds carry the TEST_KEY_PREFIX key and are deleted by afterAll as the owner (platform rows are
// no company's, so no company cleanup reaches them). A test row is active only for the sync that turns it off: other
// suites running meanwhile read every active platform case (they tolerate transient ones).
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const TEST_KEY_PREFIX = `test.sync_${crypto.randomUUID().slice(0, 8)}`;
let ownerPool: Pool;
let ownerDb: NodePgDatabase;

const loaded = Schemas.loadPlatformEvalCases();
if (!loaded.isSuccess) throw new Error(loaded.message);
const codeCases = loaded.cases;

async function storedByKey() {
  const rows = await ownerDb
    .select()
    .from(evalCases)
    .where(
      inArray(
        evalCases.platformKey,
        codeCases.map((evalCase) => evalCase.platformKey),
      ),
    );
  return new Map(rows.map((row) => [row.platformKey, row]));
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
    await ownerDb.delete(evalCases).where(like(evalCases.platformKey, `${TEST_KEY_PREFIX}%`));
  } finally {
    await ownerPool.end();
  }
});

describe("PlatformEvalCasesRepo.sync", () => {
  it("writes every case in code, active, then changes nothing on a rerun", async () => {
    const synced = await new PlatformEvalCasesRepo(env).sync();
    expect(synced.isSuccess).toBe(true);

    const stored = await storedByKey();
    for (const evalCase of codeCases) {
      const row = stored.get(evalCase.platformKey);
      expect(row).toMatchObject({
        companyId: null,
        chatbotId: null,
        name: evalCase.name,
        isSafety: evalCase.isSafety,
        isActive: true,
        input: evalCase.input,
        expectations: evalCase.expectations,
      });
      // DEV_NOTE: Every runnable path reads it back as the same case
      expect(Schemas.readEvalCaseBody(row?.input, row?.expectations)).not.toBeNull();
    }

    // DEV_NOTE: jsonb reorders keys; the compare doesn't see that as a change
    const rerun = await new PlatformEvalCasesRepo(env).sync();
    expect(rerun).toMatchObject({
      isSuccess: true,
      createdCount: 0,
      updatedCount: 0,
      deactivatedCount: 0,
      keptSafetyKeys: [],
    });
  });

  it("rewrites a case edited outside the code back to the code's", async () => {
    await new PlatformEvalCasesRepo(env).sync();
    const [first] = codeCases;
    if (!first) throw new Error("No platform case in code");
    await ownerDb
      .update(evalCases)
      .set({ name: "Edited by hand" })
      .where(eq(evalCases.platformKey, first.platformKey));

    const synced = await new PlatformEvalCasesRepo(env).sync();
    expect(synced).toMatchObject({ isSuccess: true, updatedCount: 1 });
    expect((await storedByKey()).get(first.platformKey)?.name).toBe(first.name);
  });

  it("turns off a keyed case no longer in code, and keeps the code's on", async () => {
    const removedKey = `${TEST_KEY_PREFIX}.removed`;
    const [first] = codeCases;
    if (!first) throw new Error("No platform case in code");
    await ownerDb.insert(evalCases).values([
      {
        publicId: Utility.generatePublicId(),
        platformKey: removedKey,
        name: "Removed from code",
        input: first.input,
        expectations: first.expectations,
      },
    ]);

    const synced = await new PlatformEvalCasesRepo(env).sync();
    expect(synced).toMatchObject({ isSuccess: true, keptSafetyKeys: [] });
    expect(synced.deactivatedCount).toBeGreaterThanOrEqual(1);
    const [removed] = await ownerDb
      .select()
      .from(evalCases)
      .where(eq(evalCases.platformKey, removedKey));
    expect(removed?.isActive).toBe(false);
    // DEV_NOTE: The cases in code stay on
    const stored = await storedByKey();
    expect(codeCases.every((evalCase) => stored.get(evalCase.platformKey)?.isActive)).toBe(true);
  });

  it("keeps a safety case no longer in code active and alerts", async () => {
    const keptKey = `${TEST_KEY_PREFIX}.safety`;
    const original = EvalCasesDAL.prototype.getPlatformEvalCases;
    const deactivate = vi.spyOn(EvalCasesDAL.prototype, "deactivatePlatformEvalCases");
    // DEV_NOTE: The retired safety case is read, never written: it exists only in this read, so no other suite runs it
    vi.spyOn(EvalCasesDAL.prototype, "getPlatformEvalCases").mockImplementation(async function (
      this: EvalCasesDAL,
      tx,
    ) {
      const read = await original.call(this, tx);
      const now = new Date();
      return {
        ...read,
        evalCases: [
          ...(read.evalCases ?? []),
          {
            id: "0",
            publicId: Utility.generatePublicId(),
            companyId: null,
            chatbotId: null,
            platformKey: keptKey,
            name: "Retired safety case",
            input: {},
            expectations: {},
            isSafety: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    });

    const synced = await new PlatformEvalCasesRepo(env).sync();
    expect(synced).toMatchObject({ isSuccess: true, keptSafetyKeys: [keptKey] });
    expect(deactivate.mock.calls[0]?.[1].ids).not.toContain("0");
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        action: Schemas.LogAction.SyncPlatformEvalCases,
        message: "Platform safety cases no longer in code are still active",
        metadata: expect.objectContaining({ keptSafetyKeys: [keptKey] }),
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
    await expect(refused).rejects.toThrow();
  });
});

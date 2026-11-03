import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import CompanyEncryptionKeysDAL from "@/data-access-layer/CompanyEncryptionKeysDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import getDbClient from "@/db/dbClient";
import {
  activityLog,
  changeRequests,
  chatbotUserSecrets,
  companies,
  companyEncryptionKeys,
  companySecrets,
  eventOutbox,
  toolCalls,
} from "@/db/tables";
import withTenant from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import MasterKeyProvider from "@/providers/masterKey";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanyEncryptionKeysRepo from "@/repositories/CompanyEncryptionKeysRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import KeyRotationRepo from "@/repositories/KeyRotationRepo";
import Utility from "@/utils/Utility";
import { adminAuditActor } from "@/repositories/audit";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Tests hit the Neon staging branch with the real staging master key (MASTER_KEY_V1 from .dev.vars). Each test
// creates its own companies, so each starts with one active key (v1). The Repos run as diletta_app (HYPERDRIVE), so RLS
// applies; values are encrypted through CompanyKeyProvider as diletta_app, and the owner connection only inserts the
// tool call, change request and chatbot user secret rows around them (their Repos need a whole chat), reads rows back,
// and deletes everything this suite created. Every sweep names its companies, so it never touches other staging data.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdCompanyIds: string[] = [];

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function createCompany(): Promise<string> {
  const created = await new CompaniesRepo(env).createCompany({
    company: { name: `Test company ${crypto.randomUUID()}` },
  });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);
  const publicId = created.company.publicId;
  const companyId = await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, publicId));
    return row?.id ?? "";
  });
  createdCompanyIds.push(companyId);
  return companyId;
}

async function encrypt(
  companyId: string,
  column: Schemas.EncryptedColumnEnum,
  plaintext: string,
): Promise<{ ciphertext: Buffer; iv: Buffer; version: number }> {
  const db = getDbClient(env);
  try {
    const encrypted = await withTenant(db, companyId, async (tx) => {
      const result = await CompanyKeyProvider.encryptValue(env, tx, {
        companyId,
        column,
        plaintext,
      });
      return result.isSuccess ? result : { isSuccess: false, message: result.message };
    });
    if (!("encryptedValue" in encrypted) || !encrypted.isSuccess) {
      throw new Error(`Value not encrypted: ${encrypted.message}`);
    }
    return {
      ciphertext: Buffer.from(encrypted.encryptedValue.ciphertext),
      iv: Buffer.from(encrypted.encryptedValue.iv),
      version: encrypted.encryptionKeyVersion,
    };
  } finally {
    await db.$client.end();
  }
}

async function decrypt(
  companyId: string,
  column: Schemas.EncryptedColumnEnum,
  stored: { ciphertext: Buffer | null; iv: Buffer | null; version: number | null },
): Promise<string | undefined> {
  if (!stored.ciphertext || !stored.iv || stored.version === null) return undefined;
  const { ciphertext, iv, version } = stored;
  const db = getDbClient(env);
  try {
    const decrypted = await withTenant(db, companyId, (tx) =>
      CompanyKeyProvider.decryptValue(env, tx, {
        companyId,
        column,
        encryptedValue: { ciphertext, iv },
        encryptionKeyVersion: version,
      }),
    );
    return "plaintext" in decrypted ? decrypted.plaintext : undefined;
  } finally {
    await db.$client.end();
  }
}

async function createModelKey(companyId: string, secret: string): Promise<string> {
  const created = await new CompanySecretsRepo(env).createCompanySecret({
    companyId,
    connectionId: null,
    companySecret: {
      type: Schemas.CompanySecretTypeIntEnum.ModelKey,
      provider: Schemas.ModelProviderEnum.Google,
      secret,
    },
  });
  if (!created.companySecret) throw new Error(`Secret not created: ${created.message}`);
  return created.companySecret.publicId;
}

// DEV_NOTE: A tool call (args) and its change request (changes), no chat behind them (no DB foreign keys)
async function createToolCallWithChange(
  companyId: string,
  args: string | null,
  changes: string,
): Promise<{ toolCallId: string; changeRequestId: string }> {
  const encryptedArgs = args
    ? await encrypt(companyId, Schemas.EncryptedColumnEnum.ToolCallArgs, args)
    : null;
  const encryptedChanges = await encrypt(
    companyId,
    Schemas.EncryptedColumnEnum.ChangeRequestChanges,
    changes,
  );
  return await withOwnerDb(async (ownerDb) => {
    const [toolCall] = await ownerDb
      .insert(toolCalls)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        conversationId: "1",
        turnId: Utility.generatePublicId(),
        toolId: "1",
        toolVersion: 1,
        encryptedArgs: encryptedArgs?.ciphertext ?? null,
        iv: encryptedArgs?.iv ?? null,
        encryptionKeyVersion: encryptedArgs?.version ?? null,
        status: Schemas.ToolCallStatusIntEnum.Ok,
      })
      .returning({ id: toolCalls.id });
    const [changeRequest] = await ownerDb
      .insert(changeRequests)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        conversationId: "1",
        toolCallId: toolCall?.id ?? "",
        encryptedChanges: encryptedChanges.ciphertext,
        iv: encryptedChanges.iv,
        encryptionKeyVersion: encryptedChanges.version,
        summary: "Test change",
        changeCount: 1,
      })
      .returning({ id: changeRequests.id });
    return { toolCallId: toolCall?.id ?? "", changeRequestId: changeRequest?.id ?? "" };
  });
}

async function createChatbotUserSecret(companyId: string, secret: string): Promise<string> {
  const encrypted = await encrypt(companyId, Schemas.EncryptedColumnEnum.ChatbotUserSecret, secret);
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .insert(chatbotUserSecrets)
      .values({
        publicId: Utility.generatePublicId(),
        companyId,
        chatbotUserId: companyId,
        connectionId: companyId,
        type: "oauth",
        encryptedSecret: encrypted.ciphertext,
        iv: encrypted.iv,
        encryptionKeyVersion: encrypted.version,
      })
      .returning({ id: chatbotUserSecrets.id });
    return row?.id ?? "";
  });
}

async function readKeys(companyId: string) {
  return await withOwnerDb(
    async (ownerDb) =>
      await ownerDb
        .select({
          version: companyEncryptionKeys.version,
          status: companyEncryptionKeys.status,
          encryptedKey: companyEncryptionKeys.encryptedKey,
          masterKeyVersion: companyEncryptionKeys.masterKeyVersion,
          destroyedAt: companyEncryptionKeys.destroyedAt,
        })
        .from(companyEncryptionKeys)
        .where(eq(companyEncryptionKeys.companyId, companyId))
        .orderBy(companyEncryptionKeys.version),
  );
}

async function readModelKeyRow(publicId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({
        ciphertext: companySecrets.encryptedSecret,
        iv: companySecrets.iv,
        version: companySecrets.encryptionKeyVersion,
      })
      .from(companySecrets)
      .where(eq(companySecrets.publicId, publicId));
    if (!row) throw new Error("Secret row not found");
    return row;
  });
}

async function rotate(companyId: string) {
  const rotated = await new CompanyEncryptionKeysRepo(env).rotateCompanyEncryptionKey({
    companyId,
    adminId: "1",
    actor: adminAuditActor("1"),
  });
  if (!rotated.isSuccess) throw new Error(`Not rotated: ${rotated.message}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(changeRequests).where(inArray(changeRequests.companyId, companyIds));
    await ownerDb.delete(toolCalls).where(inArray(toolCalls.companyId, companyIds));
    await ownerDb
      .delete(chatbotUserSecrets)
      .where(inArray(chatbotUserSecrets.companyId, companyIds));
    await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
    await ownerDb
      .delete(companyEncryptionKeys)
      .where(inArray(companyEncryptionKeys.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("KeyRotationRepo", { timeout: 120_000 }, () => {
  it("moves every encrypted column to the new key, then retires the old one with a System audit row", async () => {
    const companyId = await createCompany();
    const modelKey = await createModelKey(companyId, "g-secret");
    const userSecretId = await createChatbotUserSecret(companyId, "user-token");
    const withArgs = await createToolCallWithChange(companyId, '{"a":1}', '{"b":2}');
    // DEV_NOTE: A purged tool call (args NULL) has nothing to move and never holds the key back
    const purged = await createToolCallWithChange(companyId, null, '{"c":3}');
    await rotate(companyId);

    const swept = await new KeyRotationRepo(env).sweep({ companyIds: [companyId] });
    expect(swept).toMatchObject({
      isSuccess: true,
      reEncryptedCount: 5,
      retiredCount: 1,
      rewrappedCount: 0,
      failedCount: 0,
      overdueCompanyCount: 0,
    });

    const keys = await readKeys(companyId);
    expect(keys.map((key) => [key.version, key.status])).toEqual([
      [1, Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed],
      [2, Schemas.CompanyEncryptionKeyStatusIntEnum.Active],
    ]);
    expect(keys[0]?.encryptedKey).toBeNull();
    expect(keys[0]?.destroyedAt).not.toBeNull();

    // No row is left on v1, and every value reads the same under v2
    const modelKeyRow = await readModelKeyRow(modelKey);
    expect(modelKeyRow.version).toBe(2);
    expect(await decrypt(companyId, Schemas.EncryptedColumnEnum.CompanySecret, modelKeyRow)).toBe(
      "g-secret",
    );
    const rows = await withOwnerDb(async (ownerDb) => ({
      userSecret: await ownerDb
        .select({
          ciphertext: chatbotUserSecrets.encryptedSecret,
          iv: chatbotUserSecrets.iv,
          version: chatbotUserSecrets.encryptionKeyVersion,
        })
        .from(chatbotUserSecrets)
        .where(eq(chatbotUserSecrets.id, userSecretId)),
      toolCalls: await ownerDb
        .select({
          id: toolCalls.id,
          ciphertext: toolCalls.encryptedArgs,
          iv: toolCalls.iv,
          version: toolCalls.encryptionKeyVersion,
        })
        .from(toolCalls)
        .where(inArray(toolCalls.id, [withArgs.toolCallId, purged.toolCallId])),
      changes: await ownerDb
        .select({
          id: changeRequests.id,
          ciphertext: changeRequests.encryptedChanges,
          iv: changeRequests.iv,
          version: changeRequests.encryptionKeyVersion,
        })
        .from(changeRequests)
        .where(inArray(changeRequests.id, [withArgs.changeRequestId, purged.changeRequestId])),
    }));
    const [userSecret] = rows.userSecret;
    expect(userSecret?.version).toBe(2);
    expect(
      userSecret &&
        (await decrypt(companyId, Schemas.EncryptedColumnEnum.ChatbotUserSecret, userSecret)),
    ).toBe("user-token");
    const args = rows.toolCalls.find((row) => row.id === withArgs.toolCallId);
    expect(args?.version).toBe(2);
    expect(args && (await decrypt(companyId, Schemas.EncryptedColumnEnum.ToolCallArgs, args))).toBe(
      '{"a":1}',
    );
    const purgedArgs = rows.toolCalls.find((row) => row.id === purged.toolCallId);
    expect(purgedArgs).toEqual({
      id: purged.toolCallId,
      ciphertext: null,
      iv: null,
      version: null,
    });
    expect(rows.changes.map((row) => row.version)).toEqual([2, 2]);
    const decryptedChanges = await Promise.all(
      rows.changes.map((row) =>
        decrypt(companyId, Schemas.EncryptedColumnEnum.ChangeRequestChanges, row),
      ),
    );
    expect(decryptedChanges.sort()).toEqual(['{"b":2}', '{"c":3}']);

    const audit = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb
          .select({
            actorType: activityLog.actorType,
            actorId: activityLog.actorId,
            entityAction: activityLog.entityAction,
            entityVersion: activityLog.entityVersion,
          })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, companyId),
              eq(activityLog.entityType, Schemas.AuditEntityTypeEnum.CompanyEncryptionKey),
            ),
          ),
    );
    expect(audit).toContainEqual({
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityAction: Schemas.AuditEntityActionEnum.Retired,
      entityVersion: 1,
    });

    // The rotation is over, so the next one may start
    const again = await new CompanyEncryptionKeysRepo(env).rotateCompanyEncryptionKey({
      companyId,
      adminId: "1",
      actor: adminAuditActor("1"),
    });
    expect(again.isSuccess).toBe(true);
    expect(again.companyEncryptionKey?.version).toBe(3);
  });

  it("walks a column in batches", async () => {
    const companyId = await createCompany();
    for (let index = 0; index < 5; index += 1) {
      await createToolCallWithChange(companyId, `{"n":${index}}`, `{"m":${index}}`);
    }
    await rotate(companyId);

    const swept = await new KeyRotationRepo(env).sweep({ companyIds: [companyId], batchSize: 2 });
    expect(swept).toMatchObject({ isSuccess: true, reEncryptedCount: 10, retiredCount: 1 });
    const left = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb
          .select({ id: toolCalls.id })
          .from(toolCalls)
          .where(and(eq(toolCalls.companyId, companyId), eq(toolCalls.encryptionKeyVersion, 1))),
    );
    expect(left).toEqual([]);
  });

  it("keeps the key Retiring while a value won't decrypt, moves the rest, and alerts once overdue", async () => {
    const companyId = await createCompany();
    const broken = await createModelKey(companyId, "g-broken");
    const userSecretId = await createChatbotUserSecret(companyId, "user-token");
    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(companySecrets)
        .set({ encryptedSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) })
        .where(eq(companySecrets.publicId, broken));
    });
    await rotate(companyId);

    const repo = new KeyRotationRepo(env);
    const swept = await repo.sweep({ companyIds: [companyId] });
    expect(swept).toMatchObject({
      isSuccess: true,
      reEncryptedCount: 1,
      retiredCount: 0,
      failedCount: 1,
      overdueCompanyCount: 0,
    });
    expect((await readKeys(companyId)).map((key) => key.status)).toEqual([
      Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
      Schemas.CompanyEncryptionKeyStatusIntEnum.Active,
    ]);
    const moved = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb
          .select({ version: chatbotUserSecrets.encryptionKeyVersion })
          .from(chatbotUserSecrets)
          .where(eq(chatbotUserSecrets.id, userSecretId)),
    );
    expect(moved).toEqual([{ version: 2 }]);

    // A day after the rotation, the stuck key alerts
    const later = await repo.sweep({
      companyIds: [companyId],
      now: Date.now() + Constants.KEY_ROTATION_OVERDUE_ALERT_MS,
    });
    expect(later).toMatchObject({ isSuccess: true, failedCount: 1, overdueCompanyCount: 1 });
  });

  it("never overwrites a value rewritten since it was read", async () => {
    const companyId = await createCompany();
    const modelKey = await createModelKey(companyId, "g-old");
    const stale = await readModelKeyRow(modelKey);
    await rotate(companyId);
    // DEV_NOTE: The admin replaces the key after the job's read: a fresh iv under v2
    const replaced = await new CompanySecretsRepo(env).updateCompanySecret({
      companyId,
      publicId: modelKey,
      companySecret: { secret: "g-new" },
    });
    expect(replaced.isSuccess).toBe(true);

    const [secretRow] = await withOwnerDb(
      async (ownerDb) =>
        await ownerDb
          .select({ id: companySecrets.id })
          .from(companySecrets)
          .where(eq(companySecrets.publicId, modelKey)),
    );
    const db = getDbClient(env);
    try {
      const updated = await withTenant(db, companyId, (tx) =>
        new CompanySecretsDAL().updateReEncryptedCompanySecret(tx, {
          companyId,
          id: secretRow?.id ?? "",
          fromEncryptionKeyVersion: 1,
          fromIv: stale.iv,
          encryptedValue: { ciphertext: stale.ciphertext, iv: stale.iv },
          encryptionKeyVersion: 2,
        }),
      );
      expect(updated).toEqual({
        isSuccess: true,
        message: "Re-encrypted value saved",
        isUpdated: false,
      });
    } finally {
      await db.$client.end();
    }

    const row = await readModelKeyRow(modelKey);
    expect(await decrypt(companyId, Schemas.EncryptedColumnEnum.CompanySecret, row)).toBe("g-new");
  });

  it("makes a rotation wait for a write in flight under the old key", async () => {
    const companyId = await createCompany();
    let releaseWrite = () => {};
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let encryptedWith: number | undefined;
    let isRotationDone = false;

    const db = getDbClient(env);
    try {
      let markEncrypted = () => {};
      const encryptedSignal = new Promise<void>((resolve) => {
        markEncrypted = resolve;
      });
      const write = withTenant(db, companyId, async (tx) => {
        const encrypted = await CompanyKeyProvider.encryptValue(env, tx, {
          companyId,
          column: Schemas.EncryptedColumnEnum.CompanySecret,
          plaintext: "in flight",
        });
        encryptedWith = encrypted.isSuccess ? encrypted.encryptionKeyVersion : undefined;
        markEncrypted();
        await writeHeld;
        return { isSuccess: true };
      });
      await encryptedSignal;

      const rotation = new CompanyEncryptionKeysRepo(env)
        .rotateCompanyEncryptionKey({ companyId, adminId: "1", actor: adminAuditActor("1") })
        .then((rotated) => {
          isRotationDone = true;
          return rotated;
        });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isRotationDone).toBe(false);

      releaseWrite();
      await write;
      expect((await rotation).isSuccess).toBe(true);
      expect(encryptedWith).toBe(1);
    } finally {
      releaseWrite();
      await db.$client.end();
    }
  });

  it("gives a write that waited on a rotation the new key", async () => {
    const companyId = await createCompany();
    const dal = new CompanyEncryptionKeysDAL();
    let releaseRotation = () => {};
    const rotationHeld = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });

    const rotationDb = getDbClient(env);
    const writeDb = getDbClient(env);
    try {
      let markLocked = () => {};
      const lockedSignal = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      // DEV_NOTE: The rotation's steps, held open before its commit
      const rotation = withTenant(rotationDb, companyId, async (tx) => {
        await dal.getCompanyEncryptionKeys(tx, { companyId, isForUpdate: true });
        await dal.markCompanyEncryptionKeyRetiring(tx, { companyId, version: 1 });
        const created = await CompanyKeyProvider.createCompanyKey(env, tx, {
          companyId,
          version: 2,
        });
        markLocked();
        await rotationHeld;
        return created;
      });
      await lockedSignal;

      const write = withTenant(writeDb, companyId, (tx) =>
        CompanyKeyProvider.encryptValue(env, tx, {
          companyId,
          column: Schemas.EncryptedColumnEnum.CompanySecret,
          plaintext: "waited",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      releaseRotation();
      expect((await rotation).isSuccess).toBe(true);

      const written = await write;
      expect(written.isSuccess).toBe(true);
      expect("encryptionKeyVersion" in written && written.encryptionKeyVersion).toBe(2);
    } finally {
      releaseRotation();
      await rotationDb.$client.end();
      await writeDb.$client.end();
    }
  });

  it("re-wraps every live company key under a new master key, leaving its values readable", async () => {
    const companyId = await createCompany();
    const modelKey = await createModelKey(companyId, "g-wrapped");
    await rotate(companyId);

    // DEV_NOTE: No v2 master key is configured yet (docs/runbooks/master-key.md), so the test brings its own
    const masterKeyV2 = await crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    const getMasterKey = MasterKeyProvider.getMasterKey.bind(MasterKeyProvider);
    vi.spyOn(MasterKeyProvider, "getMasterKey").mockImplementation(async (keyEnv, version) =>
      version === 2
        ? { isSuccess: true, message: "Master key read successfully", masterKey: masterKeyV2 }
        : await getMasterKey(keyEnv, version),
    );

    const swept = await new KeyRotationRepo(env).sweep({
      companyIds: [companyId],
      masterKeyVersion: 2,
    });
    expect(swept).toMatchObject({ isSuccess: true, rewrappedCount: 2, retiredCount: 1 });
    expect((await readKeys(companyId)).map((key) => [key.status, key.masterKeyVersion])).toEqual([
      [Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed, 2],
      [Schemas.CompanyEncryptionKeyStatusIntEnum.Active, 2],
    ]);

    const row = await readModelKeyRow(modelKey);
    expect(await decrypt(companyId, Schemas.EncryptedColumnEnum.CompanySecret, row)).toBe(
      "g-wrapped",
    );

    // Nothing left to do: the next run finds no work
    const again = await new KeyRotationRepo(env).sweep({
      companyIds: [companyId],
      masterKeyVersion: 2,
    });
    expect(again).toMatchObject({ isSuccess: true, rewrappedCount: 0, reEncryptedCount: 0 });
  });

  it("never reads, moves or destroys another company's values inside a tenant transaction", async () => {
    const companyA = await createCompany();
    const companyB = await createCompany();
    const secretB = await createModelKey(companyB, "g-b");
    await rotate(companyA);
    await rotate(companyB);
    const storedB = await readModelKeyRow(secretB);

    // DEV_NOTE: Called directly inside A's transaction with B's id: only RLS stops it
    const db = getDbClient(env);
    const keysDal = new CompanyEncryptionKeysDAL();
    const secretsDal = new CompanySecretsDAL();
    try {
      const read = await withTenant(db, companyA, (tx) =>
        secretsDal.getCompanySecretsOnKeyVersion(tx, {
          companyId: companyB,
          encryptionKeyVersion: 1,
          afterId: null,
          limit: 10,
        }),
      );
      expect("values" in read && read.values).toEqual([]);

      const counted = await withTenant(db, companyA, (tx) =>
        secretsDal.getCompanySecretsOnKeyVersionCount(tx, {
          companyId: companyB,
          encryptionKeyVersion: 1,
        }),
      );
      expect("totalRecords" in counted && counted.totalRecords).toBe(0);

      const destroyed = await withTenant(db, companyA, (tx) =>
        keysDal.destroyCompanyEncryptionKey(tx, { companyId: companyB, version: 1 }),
      );
      expect(destroyed).toMatchObject({ isSuccess: false, isNotFound: true });
    } finally {
      await db.$client.end();
    }

    // Sweeping A leaves B as it was
    const swept = await new KeyRotationRepo(env).sweep({ companyIds: [companyA] });
    expect(swept).toMatchObject({ isSuccess: true, retiredCount: 1 });
    expect((await readKeys(companyB)).map((key) => key.status)).toEqual([
      Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
      Schemas.CompanyEncryptionKeyStatusIntEnum.Active,
    ]);
    expect(await readModelKeyRow(secretB)).toEqual(storedB);
  });
});

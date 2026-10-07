import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import CompanyEncryptionKeysDAL from "@/data-access-layer/CompanyEncryptionKeysDAL";
import getDbClient from "@/db/dbClient";
import { companies, companyEncryptionKeys, companySecrets } from "@/db/tables";
import withTenant from "@/db/withTenant";
import CompaniesRepo from "@/repositories/CompaniesRepo";
import CompanyEncryptionKeysRepo from "@/repositories/CompanyEncryptionKeysRepo";
import CompanySecretsRepo from "@/repositories/CompanySecretsRepo";
import Utility from "@/utils/Utility";
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

// DEV_NOTE: Tests hit the Neon staging branch with the real staging master key (MASTER_KEY_V1 from .dev.vars).
// Each test creates its own companies through CompaniesRepo, so each starts with exactly one active key (v1).
// The Repos run as diletta_app (HYPERDRIVE), so RLS applies; the owner connection resolves internal ids, plays
// the rotation job's destroy step, and deletes every secret, key and company this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdCompanyIds: string[] = [];

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function createCompany(name = `Test company ${crypto.randomUUID()}`): Promise<string> {
  const created = await new CompaniesRepo(env).createCompany({ company: { name } });
  if (!created.company) throw new Error(`Company not created: ${created.message}`);
  const publicId = created.company.publicId;

  let companyId = "";
  await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, publicId));
    companyId = row?.id ?? "";
  });
  createdCompanyIds.push(companyId);
  return companyId;
}

async function createModelKey(
  companyId: string,
  provider: Schemas.ModelProviderEnum,
  secret: string,
) {
  const created = await new CompanySecretsRepo(env).createCompanySecret({
    companyId,
    connectionId: null,
    companySecret: { type: Schemas.CompanySecretTypeIntEnum.ModelKey, provider, secret },
  });
  if (!created.companySecret) throw new Error(`Secret not created: ${created.message}`);
  return created.companySecret.publicId;
}

async function storedKeyVersion(publicId: string): Promise<number | undefined> {
  let version: number | undefined;
  await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ version: companySecrets.encryptionKeyVersion })
      .from(companySecrets)
      .where(eq(companySecrets.publicId, publicId));
    version = row?.version;
  });
  return version;
}

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
    await ownerDb
      .delete(companyEncryptionKeys)
      .where(inArray(companyEncryptionKeys.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("CompanyEncryptionKeysRepo", () => {
  it("creates the first key with the company, encrypted by the current master key", async () => {
    const companyId = await createCompany();
    const repo = new CompanyEncryptionKeysRepo(env);

    const active = await repo.getActiveCompanyEncryptionKey({ companyId });
    expect(active.isSuccess).toBe(true);
    expect(active.companyEncryptionKey?.version).toBe(1);
    expect(active.companyEncryptionKey?.masterKeyVersion).toBe(1);
    expect(active.companyEncryptionKey?.companyEncryptionKeyStatusLabel).toBe(
      Schemas.CompanyEncryptionKeyStatusLabelEnum.Active,
    );
    expect(active.companyEncryptionKey).not.toHaveProperty("id");
    expect(active.companyEncryptionKey).not.toHaveProperty("companyId");
    expect(active.companyEncryptionKey).not.toHaveProperty("encryptedKey");

    await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .select({ encryptedKey: companyEncryptionKeys.encryptedKey })
        .from(companyEncryptionKeys)
        .where(eq(companyEncryptionKeys.companyId, companyId));
      // iv (12) ‖ key (32) ‖ GCM tag (16)
      expect(row?.encryptedKey?.byteLength).toBe(60);
    });
  });

  it("rotates: the old key retires, the new one is active, and values from both versions decrypt", async () => {
    const companyId = await createCompany();
    const keysRepo = new CompanyEncryptionKeysRepo(env);
    const secretsRepo = new CompanySecretsRepo(env);
    const before = await createModelKey(companyId, Schemas.ModelProviderEnum.Google, "g-before");
    expect(await storedKeyVersion(before)).toBe(1);

    const rotated = await keysRepo.rotateCompanyEncryptionKey({ companyId });
    expect(rotated.isSuccess).toBe(true);
    expect(rotated.companyEncryptionKey?.version).toBe(2);
    expect(rotated.companyEncryptionKey?.companyEncryptionKeyStatus).toBe(
      Schemas.CompanyEncryptionKeyStatusIntEnum.Active,
    );

    const listed = await keysRepo.getCompanyEncryptionKeys({ companyId });
    expect(
      listed.companyEncryptionKeys?.map((key) => [key.version, key.companyEncryptionKeyStatus]),
    ).toEqual([
      [1, Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring],
      [2, Schemas.CompanyEncryptionKeyStatusIntEnum.Active],
    ]);

    // A value written before the rotation still decrypts with its own version
    const oldValue = await secretsRepo.getDecryptedCompanySecret({ companyId, publicId: before });
    expect(oldValue.secret).toBe("g-before");

    // New values use the new key
    const after = await createModelKey(companyId, Schemas.ModelProviderEnum.Anthropic, "a-after");
    expect(await storedKeyVersion(after)).toBe(2);
    const newValue = await secretsRepo.getDecryptedCompanySecret({ companyId, publicId: after });
    expect(newValue.secret).toBe("a-after");

    // Replacing an old value moves it to the new key
    const replaced = await secretsRepo.updateCompanySecret({
      companyId,
      publicId: before,
      companySecret: { secret: "g-replaced" },
    });
    expect(replaced.isSuccess).toBe(true);
    expect(await storedKeyVersion(before)).toBe(2);
    const replacedValue = await secretsRepo.getDecryptedCompanySecret({
      companyId,
      publicId: before,
    });
    expect(replacedValue.secret).toBe("g-replaced");
  });

  it("refuses a second rotation while a retiring key is still waiting for the rotation job", async () => {
    const companyId = await createCompany();
    const repo = new CompanyEncryptionKeysRepo(env);
    expect((await repo.rotateCompanyEncryptionKey({ companyId })).isSuccess).toBe(true);

    const again = await repo.rotateCompanyEncryptionKey({ companyId });
    expect(again).toEqual({ isSuccess: false, message: "Key rotation already in progress" });

    const listed = await repo.getCompanyEncryptionKeys({ companyId });
    expect(listed.companyEncryptionKeys?.map((key) => key.version)).toEqual([1, 2]);
    const active = await repo.getActiveCompanyEncryptionKey({ companyId });
    expect(active.companyEncryptionKey?.version).toBe(2);
  });

  it("crypto-shreds: once the old key is destroyed its values are gone, and rotation continues past it", async () => {
    const companyId = await createCompany();
    const keysRepo = new CompanyEncryptionKeysRepo(env);
    const secretsRepo = new CompanySecretsRepo(env);
    const shredded = await createModelKey(companyId, Schemas.ModelProviderEnum.Google, "g-v1");
    await keysRepo.rotateCompanyEncryptionKey({ companyId });
    const kept = await createModelKey(companyId, Schemas.ModelProviderEnum.OpenAI, "o-v2");

    // DEV_NOTE: The rotation job's destroy step (M6-3), played by the owner connection
    await withOwnerDb(async (ownerDb) => {
      const conditions = [
        eq(companyEncryptionKeys.companyId, companyId),
        eq(companyEncryptionKeys.version, 1),
      ];
      await ownerDb
        .update(companyEncryptionKeys)
        .set({
          status: Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed,
          encryptedKey: null,
          destroyedAt: new Date(),
        })
        .where(and(...conditions));
    });

    const gone = await secretsRepo.getDecryptedCompanySecret({ companyId, publicId: shredded });
    expect(gone).toEqual({ isSuccess: false, message: "Encryption key destroyed" });
    const stillThere = await secretsRepo.getDecryptedCompanySecret({ companyId, publicId: kept });
    expect(stillThere.secret).toBe("o-v2");

    const rotated = await keysRepo.rotateCompanyEncryptionKey({ companyId });
    expect(rotated.isSuccess).toBe(true);
    expect(rotated.companyEncryptionKey?.version).toBe(3);
  });

  it("refuses a company key copied from another company", async () => {
    const companyA = await createCompany();
    const companyB = await createCompany();
    const secretB = await createModelKey(companyB, Schemas.ModelProviderEnum.Google, "g-b");

    // DEV_NOTE: The aad binds encrypted_key to its company and version, so A's key in B's row can't be decrypted
    await withOwnerDb(async (ownerDb) => {
      const [keyA] = await ownerDb
        .select({ encryptedKey: companyEncryptionKeys.encryptedKey })
        .from(companyEncryptionKeys)
        .where(eq(companyEncryptionKeys.companyId, companyA));
      await ownerDb
        .update(companyEncryptionKeys)
        .set({ encryptedKey: keyA?.encryptedKey ?? null })
        .where(eq(companyEncryptionKeys.companyId, companyB));
    });

    const decrypted = await new CompanySecretsRepo(env).getDecryptedCompanySecret({
      companyId: companyB,
      publicId: secretB,
    });
    expect(decrypted).toEqual({ isSuccess: false, message: "Company key could not be decrypted" });
  });

  it("refuses to rotate a company that has no key", async () => {
    let companyId = "";
    await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .insert(companies)
        .values({
          publicId: Utility.generatePublicId(),
          name: `Test company ${crypto.randomUUID()}`,
        })
        .returning({ id: companies.id });
      companyId = row?.id ?? "";
    });
    createdCompanyIds.push(companyId);
    const repo = new CompanyEncryptionKeysRepo(env);

    expect(await repo.rotateCompanyEncryptionKey({ companyId })).toEqual({
      isSuccess: false,
      message: "Active encryption key not found",
    });
    expect(await repo.getActiveCompanyEncryptionKey({ companyId })).toEqual({
      isSuccess: false,
      message: "Active encryption key not found",
      companyEncryptionKey: undefined,
    });
  });

  it("never reads or retires another company's key inside a tenant transaction", async () => {
    const companyA = await createCompany();
    const companyB = await createCompany();

    // DEV_NOTE: The Repo always passes the tenant's own id, so the DAL is called directly inside company A's
    // transaction with B's id. Only RLS stops it: the DAL's company filter alone would match B's rows.
    const db = getDbClient(env);
    const dal = new CompanyEncryptionKeysDAL();
    try {
      const active = await withTenant(db, companyA, (tx) =>
        dal.getActiveCompanyEncryptionKey(tx, { companyId: companyB }),
      );
      expect(active).toEqual({ isSuccess: false, message: "Active encryption key not found" });

      const listed = await withTenant(db, companyA, (tx) =>
        dal.getCompanyEncryptionKeys(tx, { companyId: companyB }),
      );
      expect(listed.isSuccess).toBe(true);
      expect("companyEncryptionKeys" in listed && listed.companyEncryptionKeys).toEqual([]);

      const retired = await withTenant(db, companyA, (tx) =>
        dal.markCompanyEncryptionKeyRetiring(tx, { companyId: companyB, version: 1 }),
      );
      expect(retired).toEqual({ isSuccess: false, message: "Active encryption key not found" });
    } finally {
      await db.$client.end();
    }

    const untouched = await new CompanyEncryptionKeysRepo(env).getActiveCompanyEncryptionKey({
      companyId: companyB,
    });
    expect(untouched.companyEncryptionKey?.version).toBe(1);
  });

  it("rolls the company back when its key can't be created", async () => {
    const name = `Test company ${crypto.randomUUID()}`;
    const repo = new CompaniesRepo({ ...env, MASTER_KEY_V1: "not base64 !!" });

    const created = await repo.createCompany({ company: { name } });
    expect(created).toEqual({
      isSuccess: false,
      message: "Master key version 1 is not base64 of 32 bytes",
    });

    await withOwnerDb(async (ownerDb) => {
      const rows = await ownerDb
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.name, name));
      expect(rows).toEqual([]);
    });
  });
});

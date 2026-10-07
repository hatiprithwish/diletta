import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import getDbClient from "@/db/dbClient";
import { companies, companyConnections, companyEncryptionKeys, companySecrets } from "@/db/tables";
import withTenant from "@/db/withTenant";
import CompaniesRepo from "@/repositories/CompaniesRepo";
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

// DEV_NOTE: Tests hit the Neon staging branch with the real staging master key. Two companies created through
// CompaniesRepo (so each has its key), one connection each as an owner fixture. The Repo runs as diletta_app
// (HYPERDRIVE), so RLS applies; afterAll deletes every secret, connection, key and company this suite created.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdCompanyIds: string[] = [];
let companyA = "";
let companyB = "";
let connectionA = "";
let connectionB = "";

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
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

async function createConnection(ownerDb: NodePgDatabase, companyId: string): Promise<string> {
  const [row] = await ownerDb
    .insert(companyConnections)
    .values({
      publicId: Utility.generatePublicId(),
      companyId,
      environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
      baseUrl: "https://host.example.com/api",
      authType: Schemas.CompanyConnectionAuthTypeEnum.ApiKeyHeader,
      authConfig: { header: "X-Api-Key" },
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.Company,
      jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
      allowedOrigins: ["https://app.example.com"],
    })
    .returning({ id: companyConnections.id });
  return row?.id ?? "";
}

const modelKey = (
  provider: Schemas.ModelProviderEnum,
  secret: string,
): Schemas.CreateCompanySecretApiRequest["companySecret"] => ({
  type: Schemas.CompanySecretTypeIntEnum.ModelKey,
  provider,
  secret,
});

beforeAll(async () => {
  companyA = await createCompany();
  companyB = await createCompany();
  await withOwnerDb(async (ownerDb) => {
    connectionA = await createConnection(ownerDb, companyA);
    connectionB = await createConnection(ownerDb, companyB);
  });
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(companySecrets).where(inArray(companySecrets.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb
      .delete(companyEncryptionKeys)
      .where(inArray(companyEncryptionKeys.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("CompanySecretsRepo", () => {
  it("encrypts on create, returns no ciphertext or plaintext, and decrypts server-side", async () => {
    const repo = new CompanySecretsRepo(env);
    const plaintext = `sk-ant-${crypto.randomUUID()}`;

    const created = await repo.createCompanySecret({
      companyId: companyA,
      connectionId: null,
      companySecret: modelKey(Schemas.ModelProviderEnum.Anthropic, plaintext),
    });
    expect(created.isSuccess).toBe(true);
    const publicId = created.companySecret?.publicId ?? "";
    expect(publicId).toBeTruthy();
    expect(created.companySecret?.lastFourChars).toBe(plaintext.slice(-4));
    expect(created.companySecret?.provider).toBe(Schemas.ModelProviderEnum.Anthropic);
    expect(created.companySecret?.companySecretTypeLabel).toBe(
      Schemas.CompanySecretTypeLabelEnum.ModelKey,
    );
    expect(created.companySecret?.companySecretStatusLabel).toBe(
      Schemas.CompanySecretStatusLabelEnum.Active,
    );
    for (const internal of [
      "id",
      "companyId",
      "connectionId",
      "encryptedSecret",
      "iv",
      "encryptionKeyVersion",
      "createdBy",
      "updatedBy",
      "secret",
    ]) {
      expect(created.companySecret).not.toHaveProperty(internal);
    }
    expect(JSON.stringify(created)).not.toContain(plaintext);

    // Stored encrypted: the plaintext bytes appear nowhere in the row
    await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.publicId, publicId));
      expect(row?.encryptionKeyVersion).toBe(1);
      expect(row?.iv.byteLength).toBe(12);
      expect(row?.encryptedSecret.includes(Buffer.from(plaintext))).toBe(false);
    });

    const decrypted = await repo.getDecryptedCompanySecret({ companyId: companyA, publicId });
    expect(decrypted).toEqual({
      isSuccess: true,
      message: "Company secret decrypted successfully",
      secret: plaintext,
    });
  });

  it("reads, lists, replaces the value and changes the status", async () => {
    const repo = new CompanySecretsRepo(env);
    const created = await repo.createCompanySecret({
      companyId: companyA,
      connectionId: null,
      companySecret: modelKey(Schemas.ModelProviderEnum.Google, "g-original-1111"),
    });
    const publicId = created.companySecret?.publicId ?? "";
    expect(created.companySecret?.rotatedAt).toBeNull();

    const fetched = await repo.getCompanySecretDetails({ companyId: companyA, publicId });
    expect(fetched.companySecret?.lastFourChars).toBe("1111");

    const listed = await repo.getCompanySecrets({ companyId: companyA });
    expect(listed.isSuccess).toBe(true);
    expect(listed.companySecrets?.some((secret) => secret.publicId === publicId)).toBe(true);
    expect(listed.companySecrets?.every((secret) => !("encryptedSecret" in secret))).toBe(true);

    const replaced = await repo.updateCompanySecret({
      companyId: companyA,
      publicId,
      companySecret: { secret: "g-replaced-2222" },
    });
    expect(replaced.isSuccess).toBe(true);
    expect(replaced.companySecret?.lastFourChars).toBe("2222");
    expect(replaced.companySecret?.rotatedAt).toBeInstanceOf(Date);
    const decrypted = await repo.getDecryptedCompanySecret({ companyId: companyA, publicId });
    expect(decrypted.secret).toBe("g-replaced-2222");

    // Partial update: status only leaves the value alone
    const revoked = await repo.updateCompanySecret({
      companyId: companyA,
      publicId,
      companySecret: { status: Schemas.CompanySecretStatusIntEnum.Revoked },
    });
    expect(revoked.companySecret?.companySecretStatusLabel).toBe(
      Schemas.CompanySecretStatusLabelEnum.Revoked,
    );
    expect(revoked.companySecret?.lastFourChars).toBe("2222");
    expect((await repo.getDecryptedCompanySecret({ companyId: companyA, publicId })).secret).toBe(
      "g-replaced-2222",
    );
  });

  it("allows one active model key per provider", async () => {
    const repo = new CompanySecretsRepo(env);
    const first = await repo.createCompanySecret({
      companyId: companyB,
      connectionId: null,
      companySecret: modelKey(Schemas.ModelProviderEnum.OpenAI, "o-first"),
    });
    expect(first.isSuccess).toBe(true);

    const clash = await repo.createCompanySecret({
      companyId: companyB,
      connectionId: null,
      companySecret: modelKey(Schemas.ModelProviderEnum.OpenAI, "o-second"),
    });
    expect(clash).toEqual({
      isSuccess: false,
      message: "Active model key already exists for this provider",
      companySecret: undefined,
    });

    await repo.updateCompanySecret({
      companyId: companyB,
      publicId: first.companySecret?.publicId ?? "",
      companySecret: { status: Schemas.CompanySecretStatusIntEnum.Invalid },
    });
    const replacement = await repo.createCompanySecret({
      companyId: companyB,
      connectionId: null,
      companySecret: modelKey(Schemas.ModelProviderEnum.OpenAI, "o-second"),
    });
    expect(replacement.isSuccess).toBe(true);
  });

  it("binds a host credential to the company's own connection only", async () => {
    const repo = new CompanySecretsRepo(env);
    const apiKey: Schemas.CreateCompanySecretApiRequest["companySecret"] = {
      type: Schemas.CompanySecretTypeIntEnum.ApiKey,
      provider: null,
      secret: "host-api-key",
    };

    const created = await repo.createCompanySecret({
      companyId: companyA,
      connectionId: connectionA,
      companySecret: apiKey,
    });
    expect(created.isSuccess).toBe(true);
    expect(created.companySecret?.provider).toBeNull();

    const clash = await repo.createCompanySecret({
      companyId: companyA,
      connectionId: connectionA,
      companySecret: apiKey,
    });
    expect(clash.message).toBe("Active secret of this type already exists for this connection");

    // DEV_NOTE: identity ids start at 1, so 0 never references a connection
    for (const connectionId of ["0", connectionB]) {
      const dangling = await repo.createCompanySecret({
        companyId: companyA,
        connectionId,
        companySecret: { ...apiKey, type: Schemas.CompanySecretTypeIntEnum.ClientSecret },
      });
      expect(dangling).toEqual({
        isSuccess: false,
        message: "Company connection not found",
        companySecret: undefined,
      });
    }
  });

  it("never reads, changes or decrypts another company's secret", async () => {
    const repo = new CompanySecretsRepo(env);
    const created = await repo.createCompanySecret({
      companyId: companyA,
      connectionId: null,
      companySecret: modelKey(Schemas.ModelProviderEnum.OpenAI, "o-company-a"),
    });
    const publicId = created.companySecret?.publicId ?? "";

    expect((await repo.getCompanySecretDetails({ companyId: companyB, publicId })).isSuccess).toBe(
      false,
    );
    expect(
      (await repo.getCompanySecrets({ companyId: companyB })).companySecrets?.some(
        (secret) => secret.publicId === publicId,
      ),
    ).toBe(false);
    expect(
      (
        await repo.updateCompanySecret({
          companyId: companyB,
          publicId,
          companySecret: { secret: "hijacked" },
        })
      ).isSuccess,
    ).toBe(false);
    expect(await repo.getDecryptedCompanySecret({ companyId: companyB, publicId })).toEqual({
      isSuccess: false,
      message: "Company secret not found",
    });

    // DEV_NOTE: The DAL is called directly inside company B's transaction with A's id: only RLS stops it
    const db = getDbClient(env);
    const dal = new CompanySecretsDAL();
    try {
      const read = await withTenant(db, companyB, (tx) =>
        dal.getCompanySecretDetails(tx, { companyId: companyA, publicId }),
      );
      expect(read).toEqual({ isSuccess: false, message: "Company secret not found" });
    } finally {
      await db.$client.end();
    }

    expect((await repo.getDecryptedCompanySecret({ companyId: companyA, publicId })).secret).toBe(
      "o-company-a",
    );
  });

  it("refuses a ciphertext copied into another company's row", async () => {
    const repo = new CompanySecretsRepo(env);
    // DEV_NOTE: HMAC keys on each company's own connection: a type no other test here creates
    const hmacKey = (secret: string): Schemas.CreateCompanySecretApiRequest["companySecret"] => ({
      type: Schemas.CompanySecretTypeIntEnum.HmacKey,
      provider: null,
      secret,
    });
    const fromA = await repo.createCompanySecret({
      companyId: companyA,
      connectionId: connectionA,
      companySecret: hmacKey("hmac-copied"),
    });
    const intoB = await repo.createCompanySecret({
      companyId: companyB,
      connectionId: connectionB,
      companySecret: hmacKey("hmac-own"),
    });
    expect(fromA.isSuccess).toBe(true);
    expect(intoB.isSuccess).toBe(true);
    const publicIdA = fromA.companySecret?.publicId ?? "";
    const publicIdB = intoB.companySecret?.publicId ?? "";

    await withOwnerDb(async (ownerDb) => {
      const [rowA] = await ownerDb
        .select()
        .from(companySecrets)
        .where(eq(companySecrets.publicId, publicIdA));
      if (!rowA) throw new Error("Secret A not found");
      await ownerDb
        .update(companySecrets)
        .set({
          encryptedSecret: rowA.encryptedSecret,
          iv: rowA.iv,
          encryptionKeyVersion: rowA.encryptionKeyVersion,
        })
        .where(eq(companySecrets.publicId, publicIdB));
    });

    const decrypted = await repo.getDecryptedCompanySecret({
      companyId: companyB,
      publicId: publicIdB,
    });
    expect(decrypted).toEqual({ isSuccess: false, message: "Value could not be decrypted" });
  });

  it("refuses to store a secret for a company with no key", async () => {
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

    const created = await new CompanySecretsRepo(env).createCompanySecret({
      companyId,
      connectionId: null,
      companySecret: modelKey(Schemas.ModelProviderEnum.Google, "g-no-key"),
    });
    expect(created).toEqual({ isSuccess: false, message: "Active encryption key not found" });
  });

  it("requires a provider for a model key, and only for one", () => {
    const parse = (companySecret: Record<string, unknown>) =>
      Schemas.ZCreateCompanySecretApiRequest.safeParse({ companySecret }).success;

    expect(
      parse({ type: Schemas.CompanySecretTypeIntEnum.ModelKey, provider: "google", secret: "k" }),
    ).toBe(true);
    expect(
      parse({ type: Schemas.CompanySecretTypeIntEnum.ModelKey, provider: null, secret: "k" }),
    ).toBe(false);
    expect(
      parse({ type: Schemas.CompanySecretTypeIntEnum.ApiKey, provider: "google", secret: "k" }),
    ).toBe(false);
    expect(
      parse({ type: Schemas.CompanySecretTypeIntEnum.ModelKey, provider: "mistral", secret: "k" }),
    ).toBe(false);
    expect(
      parse({ type: Schemas.CompanySecretTypeIntEnum.ApiKey, provider: null, secret: "  " }),
    ).toBe(false);
  });
});

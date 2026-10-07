import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import ChatbotUserSecretsDAL from "@/data-access-layer/ChatbotUserSecretsDAL";
import getDbClient from "@/db/dbClient";
import {
  chatbotUserSecrets,
  chatbotUsers,
  companies,
  companyConnections,
  companyEncryptionKeys,
} from "@/db/tables";
import withTenant from "@/db/withTenant";
import ChatbotUserSecretsRepo from "@/repositories/ChatbotUserSecretsRepo";
import CompaniesRepo from "@/repositories/CompaniesRepo";
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
// CompaniesRepo (so each has its key); chatbot users and connections are owner fixtures. The Repo runs as
// diletta_app (HYPERDRIVE), so RLS applies; afterAll deletes every row this suite created.
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
      authType: Schemas.CompanyConnectionAuthTypeEnum.Oauth2Authcode,
      authConfig: { tokenUrl: "https://host.example.com/token" },
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.ChatbotUser,
      jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
      allowedOrigins: ["https://app.example.com"],
    })
    .returning({ id: companyConnections.id });
  return row?.id ?? "";
}

async function createChatbotUser(companyId: string, erasedAt: Date | null = null) {
  let chatbotUserId = "";
  await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .insert(chatbotUsers)
      .values({ companyId, hostUserId: `host_${crypto.randomUUID()}`, erasedAt })
      .returning({ id: chatbotUsers.id });
    chatbotUserId = row?.id ?? "";
  });
  return chatbotUserId;
}

const credential = (accessToken: string): Schemas.ChatbotUserSecretValue => ({
  accessToken,
  refreshToken: `refresh-${accessToken}`,
  tokenType: "Bearer",
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
    await ownerDb
      .delete(chatbotUserSecrets)
      .where(inArray(chatbotUserSecrets.companyId, companyIds));
    await ownerDb.delete(chatbotUsers).where(inArray(chatbotUsers.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb
      .delete(companyEncryptionKeys)
      .where(inArray(companyEncryptionKeys.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("ChatbotUserSecretsRepo", () => {
  it("encrypts the credential, takes its type from the connection, and decrypts it server-side", async () => {
    const repo = new ChatbotUserSecretsRepo(env);
    const chatbotUserId = await createChatbotUser(companyA);
    const accessToken = `at-${crypto.randomUUID()}`;

    const created = await repo.createChatbotUserSecret({
      companyId: companyA,
      chatbotUserId,
      connectionId: connectionA,
      chatbotUserSecret: { secret: credential(accessToken), scopes: ["records:read"] },
    });
    expect(created.isSuccess).toBe(true);
    const publicId = created.chatbotUserSecret?.publicId ?? "";
    expect(created.chatbotUserSecret?.type).toBe(
      Schemas.CompanyConnectionAuthTypeEnum.Oauth2Authcode,
    );
    expect(created.chatbotUserSecret?.scopes).toEqual(["records:read"]);
    expect(created.chatbotUserSecret?.expiresAt).toBeNull();
    expect(created.chatbotUserSecret?.chatbotUserSecretStatusLabel).toBe(
      Schemas.ChatbotUserSecretStatusLabelEnum.Active,
    );
    for (const internal of [
      "id",
      "companyId",
      "chatbotUserId",
      "connectionId",
      "encryptedSecret",
      "iv",
      "encryptionKeyVersion",
      "secret",
    ]) {
      expect(created.chatbotUserSecret).not.toHaveProperty(internal);
    }
    expect(JSON.stringify(created)).not.toContain(accessToken);

    await withOwnerDb(async (ownerDb) => {
      const [row] = await ownerDb
        .select()
        .from(chatbotUserSecrets)
        .where(eq(chatbotUserSecrets.publicId, publicId));
      expect(row?.encryptedSecret.includes(Buffer.from(accessToken))).toBe(false);
    });

    const decrypted = await repo.getDecryptedChatbotUserSecret({ companyId: companyA, publicId });
    expect(decrypted).toEqual({
      isSuccess: true,
      message: "Chatbot user secret decrypted successfully",
      secret: credential(accessToken),
    });
  });

  it("reads, lists by chatbot user, replaces the credential and changes the status", async () => {
    const repo = new ChatbotUserSecretsRepo(env);
    const chatbotUserId = await createChatbotUser(companyA);
    const created = await repo.createChatbotUserSecret({
      companyId: companyA,
      chatbotUserId,
      connectionId: connectionA,
      chatbotUserSecret: { secret: credential("first") },
    });
    const publicId = created.chatbotUserSecret?.publicId ?? "";

    const fetched = await repo.getChatbotUserSecretDetails({ companyId: companyA, publicId });
    expect(fetched.chatbotUserSecret?.publicId).toBe(publicId);

    const listed = await repo.getChatbotUserSecrets({ companyId: companyA, chatbotUserId });
    expect(listed.chatbotUserSecrets?.map((secret) => secret.publicId)).toEqual([publicId]);

    const expiresAt = new Date("2027-01-01T00:00:00.000Z");
    const refreshed = await repo.updateChatbotUserSecret({
      companyId: companyA,
      publicId,
      chatbotUserSecret: { secret: credential("second"), expiresAt },
    });
    expect(refreshed.isSuccess).toBe(true);
    expect(refreshed.chatbotUserSecret?.expiresAt).toEqual(expiresAt);
    expect(
      (await repo.getDecryptedChatbotUserSecret({ companyId: companyA, publicId })).secret,
    ).toEqual(credential("second"));

    const needsReauth = await repo.updateChatbotUserSecret({
      companyId: companyA,
      publicId,
      chatbotUserSecret: { status: Schemas.ChatbotUserSecretStatusIntEnum.NeedsReauth },
    });
    expect(needsReauth.chatbotUserSecret?.chatbotUserSecretStatusLabel).toBe(
      Schemas.ChatbotUserSecretStatusLabelEnum.NeedsReauth,
    );
    expect(
      (await repo.getDecryptedChatbotUserSecret({ companyId: companyA, publicId })).secret,
    ).toEqual(credential("second"));
  });

  it("keeps one credential per chatbot user and connection", async () => {
    const repo = new ChatbotUserSecretsRepo(env);
    const chatbotUserId = await createChatbotUser(companyA);
    const input = {
      companyId: companyA,
      chatbotUserId,
      connectionId: connectionA,
      chatbotUserSecret: { secret: credential("only") },
    };
    expect((await repo.createChatbotUserSecret(input)).isSuccess).toBe(true);

    const clash = await repo.createChatbotUserSecret(input);
    expect(clash).toEqual({
      isSuccess: false,
      message: "Secret already exists for this chatbot user and connection",
      chatbotUserSecret: undefined,
    });
  });

  it("refuses a missing, erased or other company's chatbot user, and a missing or other company's connection", async () => {
    const repo = new ChatbotUserSecretsRepo(env);
    const chatbotUserA = await createChatbotUser(companyA);
    const erasedUserA = await createChatbotUser(companyA, new Date());
    const chatbotUserB = await createChatbotUser(companyB);
    const create = (chatbotUserId: string, connectionId: string) =>
      repo.createChatbotUserSecret({
        companyId: companyA,
        chatbotUserId,
        connectionId,
        chatbotUserSecret: { secret: credential("dangling") },
      });

    // DEV_NOTE: identity ids start at 1, so 0 never references a row
    for (const chatbotUserId of ["0", erasedUserA, chatbotUserB]) {
      expect(await create(chatbotUserId, connectionA)).toEqual({
        isSuccess: false,
        message: "Chatbot user not found",
        chatbotUserSecret: undefined,
      });
    }
    for (const connectionId of ["0", connectionB]) {
      expect(await create(chatbotUserA, connectionId)).toEqual({
        isSuccess: false,
        message: "Company connection not found",
        chatbotUserSecret: undefined,
      });
    }
  });

  it("never reads, changes or decrypts another company's credential", async () => {
    const repo = new ChatbotUserSecretsRepo(env);
    const chatbotUserId = await createChatbotUser(companyA);
    const created = await repo.createChatbotUserSecret({
      companyId: companyA,
      chatbotUserId,
      connectionId: connectionA,
      chatbotUserSecret: { secret: credential("company-a") },
    });
    const publicId = created.chatbotUserSecret?.publicId ?? "";

    expect(
      (await repo.getChatbotUserSecretDetails({ companyId: companyB, publicId })).isSuccess,
    ).toBe(false);
    expect(
      (await repo.getChatbotUserSecrets({ companyId: companyB, chatbotUserId })).chatbotUserSecrets,
    ).toEqual([]);
    expect(
      (
        await repo.updateChatbotUserSecret({
          companyId: companyB,
          publicId,
          chatbotUserSecret: { status: Schemas.ChatbotUserSecretStatusIntEnum.Revoked },
        })
      ).isSuccess,
    ).toBe(false);
    expect(await repo.getDecryptedChatbotUserSecret({ companyId: companyB, publicId })).toEqual({
      isSuccess: false,
      message: "Chatbot user secret not found",
    });

    // DEV_NOTE: The DAL is called directly inside company B's transaction with A's id: only RLS stops it
    const db = getDbClient(env);
    const dal = new ChatbotUserSecretsDAL();
    try {
      const read = await withTenant(db, companyB, (tx) =>
        dal.getChatbotUserSecretDetails(tx, { companyId: companyA, publicId }),
      );
      expect(read).toEqual({ isSuccess: false, message: "Chatbot user secret not found" });
    } finally {
      await db.$client.end();
    }

    const untouched = await repo.getChatbotUserSecretDetails({ companyId: companyA, publicId });
    expect(untouched.chatbotUserSecret?.chatbotUserSecretStatusLabel).toBe(
      Schemas.ChatbotUserSecretStatusLabelEnum.Active,
    );
  });

  it("accepts only a JSON object as the credential", () => {
    const parse = (secret: unknown) =>
      Schemas.ZCreateChatbotUserSecretApiRequest.safeParse({ chatbotUserSecret: { secret } })
        .success;

    expect(parse({ accessToken: "t", nested: { a: [1, true, null] } })).toBe(true);
    expect(parse("token")).toBe(false);
    expect(parse(["token"])).toBe(false);
    expect(parse(null)).toBe(false);
  });
});

import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { companies, companyConnections } from "@/db/tables";
import CompanyConnectionsRepo from "@/repositories/CompanyConnectionsRepo";
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

// DEV_NOTE: Tests hit the Neon staging branch. Two fresh companies per run isolate rows; afterAll deletes
// every connection and company this suite created. The Repo runs as diletta_app (HYPERDRIVE), so RLS
// applies; fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let companyA = "";
let companyB = "";

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

// DEV_NOTE: jwt_issuer is unique across every company on the branch, so each connection gets a fresh one
const connectionInput = (
  overrides: Partial<Schemas.CreateCompanyConnectionApiRequest["companyConnection"]> = {},
): Schemas.CreateCompanyConnectionApiRequest["companyConnection"] => ({
  environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
  baseUrl: "https://host.example.com/api",
  authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
  authConfig: { header: "Authorization" },
  credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
  jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
  allowedOrigins: ["https://app.example.com"],
  ...overrides,
});

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Test company A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Test company B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
  });
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("CompanyConnectionsRepo", () => {
  it("creates, reads, lists and updates a connection", async () => {
    const repo = new CompanyConnectionsRepo(env);

    const created = await repo.createCompanyConnection({
      companyId: companyA,
      companyConnection: connectionInput(),
    });
    expect(created.isSuccess).toBe(true);
    const publicId = created.companyConnection?.publicId ?? "";
    expect(publicId).toBeTruthy();
    expect(created.companyConnection).not.toHaveProperty("id");
    expect(created.companyConnection).not.toHaveProperty("companyId");
    expect(created.companyConnection).not.toHaveProperty("createdBy");
    expect(created.companyConnection).not.toHaveProperty("updatedBy");
    expect(created.companyConnection?.authConfig).toEqual({ header: "Authorization" });
    expect(created.companyConnection?.resetOp).toBeNull();
    expect(created.companyConnection?.companyConnectionStatusLabel).toBe(
      Schemas.CompanyConnectionStatusLabelEnum.Active,
    );
    expect(created.companyConnection?.companyConnectionEnvironmentLabel).toBe(
      Schemas.CompanyConnectionEnvironmentLabelEnum.Staging,
    );
    // DEV_NOTE: adapterType defaults to REST when the request omits it
    expect(created.companyConnection?.companyConnectionAdapterType).toBe(
      Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
    );
    expect(created.companyConnection?.companyConnectionAdapterTypeLabel).toBe(
      Schemas.CompanyConnectionAdapterTypeLabelEnum.Rest,
    );
    expect(created.companyConnection?.companyConnectionCredentialScopeLabel).toBe(
      Schemas.CompanyConnectionCredentialScopeLabelEnum.None,
    );

    const fetched = await repo.getCompanyConnectionDetails({ companyId: companyA, publicId });
    expect(fetched.isSuccess).toBe(true);
    expect(fetched.companyConnection?.jwtIssuer).toBe(created.companyConnection?.jwtIssuer);

    const listed = await repo.getCompanyConnections({ companyId: companyA });
    expect(listed.isSuccess).toBe(true);
    expect(listed.companyConnections?.some((connection) => connection.publicId === publicId)).toBe(
      true,
    );

    // Partial update: omitted fields are left unchanged
    const disabled = await repo.updateCompanyConnection({
      companyId: companyA,
      publicId,
      companyConnection: {
        status: Schemas.CompanyConnectionStatusIntEnum.Disabled,
        allowedOrigins: ["https://app.example.com", "https://admin.example.com"],
      },
    });
    expect(disabled.isSuccess).toBe(true);
    expect(disabled.companyConnection?.baseUrl).toBe("https://host.example.com/api");
    expect(disabled.companyConnection?.allowedOrigins).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
    expect(disabled.companyConnection?.companyConnectionStatusLabel).toBe(
      Schemas.CompanyConnectionStatusLabelEnum.Disabled,
    );
  });

  it("never reads or writes another company's connection", async () => {
    const repo = new CompanyConnectionsRepo(env);
    const created = await repo.createCompanyConnection({
      companyId: companyA,
      companyConnection: connectionInput(),
    });
    const publicId = created.companyConnection?.publicId ?? "";

    const fetched = await repo.getCompanyConnectionDetails({ companyId: companyB, publicId });
    expect(fetched.isSuccess).toBe(false);

    const listed = await repo.getCompanyConnections({ companyId: companyB });
    expect(listed.companyConnections?.some((connection) => connection.publicId === publicId)).toBe(
      false,
    );

    const updated = await repo.updateCompanyConnection({
      companyId: companyB,
      publicId,
      companyConnection: { baseUrl: "https://attacker.example.com" },
    });
    expect(updated.isSuccess).toBe(false);

    const untouched = await repo.getCompanyConnectionDetails({ companyId: companyA, publicId });
    expect(untouched.companyConnection?.baseUrl).toBe("https://host.example.com/api");
  });

  it("refuses an issuer another company already uses, on create and update", async () => {
    const repo = new CompanyConnectionsRepo(env);
    const taken = connectionInput();
    const first = await repo.createCompanyConnection({
      companyId: companyA,
      companyConnection: taken,
    });
    expect(first.isSuccess).toBe(true);

    const clash = await repo.createCompanyConnection({
      companyId: companyB,
      companyConnection: connectionInput({ jwtIssuer: taken.jwtIssuer }),
    });
    expect(clash).toEqual({
      isSuccess: false,
      message: "Issuer already in use",
      companyConnection: undefined,
    });

    const other = await repo.createCompanyConnection({
      companyId: companyB,
      companyConnection: connectionInput(),
    });
    const updateClash = await repo.updateCompanyConnection({
      companyId: companyB,
      publicId: other.companyConnection?.publicId ?? "",
      companyConnection: { jwtIssuer: taken.jwtIssuer },
    });
    expect(updateClash).toEqual({
      isSuccess: false,
      message: "Issuer already in use",
      companyConnection: undefined,
    });
  });

  it("refuses to create a connection for a company that does not exist", async () => {
    const repo = new CompanyConnectionsRepo(env);
    // DEV_NOTE: identity ids start at 1, so 0 never references a company
    const result = await repo.createCompanyConnection({
      companyId: "0",
      companyConnection: connectionInput(),
    });
    expect(result).toEqual({
      isSuccess: false,
      message: "Company not found",
      companyConnection: undefined,
    });
  });

  it("requires a base URL unless the adapter is host-executed", () => {
    const missing = Schemas.ZCreateCompanyConnectionApiRequest.safeParse({
      companyConnection: connectionInput({ baseUrl: null }),
    });
    expect(missing.success).toBe(false);

    const hostExec = Schemas.ZCreateCompanyConnectionApiRequest.safeParse({
      companyConnection: connectionInput({
        baseUrl: null,
        adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.HostExec,
      }),
    });
    expect(hostExec.success).toBe(true);
  });
});

import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { companies } from "@/db/tables";
import CompaniesRepo from "@/repositories/CompaniesRepo";
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

// DEV_NOTE: Tests hit the Neon staging branch. The Repo runs as diletta_app (HYPERDRIVE), so RLS applies;
// the owner connection only resolves internal ids (never in an API response) and cleans up afterwards.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdPublicIds: string[] = [];

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function createCompany(repo: CompaniesRepo, name: string) {
  const created = await repo.createCompany({ company: { name } });
  const publicId = created.company?.publicId ?? "";
  createdPublicIds.push(publicId);

  let companyId = "";
  await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.publicId, publicId));
    companyId = row?.id ?? "";
  });
  return { created, publicId, companyId };
}

afterAll(async () => {
  const publicIds = createdPublicIds.filter(Boolean);
  if (publicIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(companies).where(inArray(companies.publicId, publicIds));
  });
});

describe("CompaniesRepo", () => {
  it("creates and lists companies across tenants, then reads and updates one as its tenant", async () => {
    const repo = new CompaniesRepo(env);
    const name = `Test company ${crypto.randomUUID()}`;

    const { created, publicId, companyId } = await createCompany(repo, name);
    expect(created.isSuccess).toBe(true);
    expect(publicId).toBeTruthy();
    expect(companyId).toBeTruthy();
    expect(created.company).not.toHaveProperty("id");
    expect(created.company).not.toHaveProperty("updatedBy");
    expect(created.company?.isReadOnly).toBe(false);
    expect(created.company?.companyStatus).toBe(Schemas.CompanyStatusIntEnum.Active);
    expect(created.company?.companyStatusLabel).toBe(Schemas.CompanyStatusLabelEnum.Active);

    const listed = await repo.getCompanies();
    expect(listed.isSuccess).toBe(true);
    expect(listed.companies?.some((company) => company.publicId === publicId)).toBe(true);
    expect(listed.companies?.every((company) => !("id" in company))).toBe(true);

    const fetched = await repo.getCompanyDetails({ companyId });
    expect(fetched.isSuccess).toBe(true);
    expect(fetched.company?.name).toBe(name);

    // Partial update: omitted name is left unchanged
    const paused = await repo.updateCompany({
      companyId,
      company: { status: Schemas.CompanyStatusIntEnum.Paused, isReadOnly: true },
    });
    expect(paused.isSuccess).toBe(true);
    expect(paused.company?.name).toBe(name);
    expect(paused.company?.isReadOnly).toBe(true);
    expect(paused.company?.companyStatusLabel).toBe(Schemas.CompanyStatusLabelEnum.Paused);
  });

  it("only reaches its own row as a tenant", async () => {
    const repo = new CompaniesRepo(env);
    const companyA = await createCompany(repo, `Test company A ${crypto.randomUUID()}`);
    const companyB = await createCompany(repo, `Test company B ${crypto.randomUUID()}`);

    const fetched = await repo.getCompanyDetails({ companyId: companyB.companyId });
    expect(fetched.company?.publicId).toBe(companyB.publicId);

    await repo.updateCompany({ companyId: companyB.companyId, company: { name: "Renamed B" } });
    const untouched = await repo.getCompanyDetails({ companyId: companyA.companyId });
    expect(untouched.company?.name).toBe(companyA.created.company?.name);
  });

  it("returns not found for a company that does not exist", async () => {
    const repo = new CompaniesRepo(env);
    // DEV_NOTE: identity ids start at 1, so 0 never references a company
    const fetched = await repo.getCompanyDetails({ companyId: "0" });
    expect(fetched).toEqual({ isSuccess: false, message: "Company not found", company: undefined });

    const updated = await repo.updateCompany({ companyId: "0", company: { name: "Ghost" } });
    expect(updated).toEqual({ isSuccess: false, message: "Company not found", company: undefined });
  });
});

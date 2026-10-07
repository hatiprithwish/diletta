import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import { companies } from "@/db/tables";
import withTenant from "@/db/withTenant";
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

    // DEV_NOTE: The list spans every company on the shared staging branch, so look among the newest page
    const listed = await repo.getCompanies({ pageSize: Schemas.MAX_PAGE_SIZE });
    expect(listed.isSuccess).toBe(true);
    expect(listed.companies?.some((company) => company.publicId === publicId)).toBe(true);
    expect(listed.companies?.every((company) => !("id" in company))).toBe(true);

    const fetched = await repo.getCompanyDetails({ companyId });
    expect(fetched.isSuccess).toBe(true);
    expect(fetched.company?.name).toBe(name);

    // Partial update: omitted name is left unchanged
    const readOnly = await repo.updateCompany({ companyId, company: { isReadOnly: true } });
    expect(readOnly.isSuccess).toBe(true);
    expect(readOnly.company?.name).toBe(name);
    expect(readOnly.company?.isReadOnly).toBe(true);

    const paused = await repo.updateCompanyStatus({
      companyId,
      company: { status: Schemas.CompanyStatusIntEnum.Paused },
    });
    expect(paused.isSuccess).toBe(true);
    expect(paused.company?.isReadOnly).toBe(true);
    expect(paused.company?.companyStatusLabel).toBe(Schemas.CompanyStatusLabelEnum.Paused);
  });

  it("pages the operator list and counts every company", async () => {
    const repo = new CompaniesRepo(env);
    await createCompany(repo, `Test company ${crypto.randomUUID()}`);
    await createCompany(repo, `Test company ${crypto.randomUUID()}`);

    const counted = await repo.getCompaniesCount();
    expect(counted.isSuccess).toBe(true);
    expect(counted.totalRecords ?? 0).toBeGreaterThanOrEqual(2);

    const pageOf = (pageNo: number) =>
      repo.getCompanies({
        pageNo,
        pageSize: 1,
        sortColumn: Schemas.CompanySortColumn.CreatedAt,
        sortDirection: Schemas.SortDirection.Asc,
      });
    const first = await pageOf(1);
    const second = await pageOf(2);
    expect(first.companies).toHaveLength(1);
    expect(second.companies).toHaveLength(1);
    expect(first.companies?.[0]?.publicId).not.toBe(second.companies?.[0]?.publicId);

    expect(
      Schemas.ZGetCompaniesApiRequest.safeParse({ pageSize: Schemas.MAX_PAGE_SIZE + 1 }).success,
    ).toBe(false);
    expect(Schemas.ZGetCompaniesApiRequest.safeParse({ sortColumn: "id" }).success).toBe(false);
  });

  it("keeps status out of what a company admin can edit", () => {
    const parsed = Schemas.ZUpdateCompanyApiRequest.parse({
      company: { name: "Renamed", status: Schemas.CompanyStatusIntEnum.Active },
    });
    expect(parsed.company).toEqual({ name: "Renamed" });
  });

  it("never reads or writes another company's row inside a tenant transaction", async () => {
    const repo = new CompaniesRepo(env);
    const companyA = await createCompany(repo, `Test company A ${crypto.randomUUID()}`);
    const companyB = await createCompany(repo, `Test company B ${crypto.randomUUID()}`);
    const nameB = companyB.created.company?.name;

    // DEV_NOTE: The Repo always passes the tenant's own id, so the DAL is called directly inside company A's
    // transaction with B's id. Only RLS stops it: the DAL's id filter alone would match B's row.
    const db = getDbClient(env);
    const dal = new CompaniesDAL();
    try {
      const read = await withTenant(db, companyA.companyId, (tx) =>
        dal.getCompanyDetails(tx, { companyId: companyB.companyId }),
      );
      expect(read).toEqual({ isSuccess: false, message: "Company not found" });

      const updated = await withTenant(db, companyA.companyId, (tx) =>
        dal.updateCompany(tx, {
          companyId: companyB.companyId,
          name: "Hijacked",
          status: null,
          isReadOnly: true,
        }),
      );
      expect(updated).toEqual({ isSuccess: false, message: "Company not found" });
    } finally {
      await db.$client.end();
    }

    const untouched = await repo.getCompanyDetails({ companyId: companyB.companyId });
    expect(untouched.isSuccess).toBe(true);
    expect(untouched.company?.name).toBe(nameB);
    expect(untouched.company?.isReadOnly).toBe(false);
  });

  it("returns not found for a company that does not exist", async () => {
    const repo = new CompaniesRepo(env);
    // DEV_NOTE: identity ids start at 1, so 0 never references a company
    const fetched = await repo.getCompanyDetails({ companyId: "0" });
    expect(fetched).toEqual({ isSuccess: false, message: "Company not found", company: undefined });

    const updated = await repo.updateCompany({ companyId: "0", company: { name: "Ghost" } });
    expect(updated).toEqual({ isSuccess: false, message: "Company not found", company: undefined });

    const statusUpdated = await repo.updateCompanyStatus({
      companyId: "0",
      company: { status: Schemas.CompanyStatusIntEnum.Churned },
    });
    expect(statusUpdated).toEqual({
      isSuccess: false,
      message: "Company not found",
      company: undefined,
    });
  });
});

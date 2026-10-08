import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import AdminsDAL from "@/data-access-layer/AdminsDAL";
import getDbClient from "@/db/dbClient";
import { admins, companies } from "@/db/tables";
import withTenant from "@/db/withTenant";
import ClerkProvider from "@/providers/clerk";
import AdminsRepo from "@/repositories/AdminsRepo";
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

// DEV_NOTE: Clerk stand-in with state: invites maps a Clerk user to the companyPublicId in their publicMetadata.
// getAdminProfile reads it and consumeInvite removes it, as the real provider does on the Clerk user.
const clerk = vi.hoisted(() => ({
  invites: new Map<string, string>(),
  isConsumeFailing: false,
}));

vi.mock("@/providers/clerk", () => ({
  default: {
    getClerkClient: vi.fn(),
    getAdminProfile: vi.fn(async (_env: unknown, clerkUserId: string) => ({
      isSuccess: true,
      profile: {
        email: "invitee@example.com",
        name: "Invited Admin",
        companyPublicId: clerk.invites.get(clerkUserId) ?? null,
      },
    })),
    consumeInvite: vi.fn(async (_env: unknown, clerkUserId: string) => {
      if (clerk.isConsumeFailing) {
        return { isSuccess: false, message: "Unknown error in consuming Clerk invite" };
      }
      clerk.invites.delete(clerkUserId);
      return { isSuccess: true };
    }),
  },
}));

// DEV_NOTE: Tests hit the Neon staging branch. The Repo runs as diletta_app (HYPERDRIVE), so RLS applies;
// fixtures (companies, operator and company admin rows) and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
let companyA = { id: "", publicId: "" };
let companyB = { id: "", publicId: "" };
let churnedCompany = { id: "", publicId: "" };
let pausedCompany = { id: "", publicId: "" };
const operatorClerkUserId = `user_op_${crypto.randomUUID()}`;
const adminAClerkUserId = `user_a_${crypto.randomUUID()}`;
const churnedAdminClerkUserId = `user_c_${crypto.randomUUID()}`;
const pausedAdminClerkUserId = `user_p_${crypto.randomUUID()}`;
const createdClerkUserIds = [
  operatorClerkUserId,
  adminAClerkUserId,
  churnedAdminClerkUserId,
  pausedAdminClerkUserId,
];

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

function newClerkUserId() {
  const clerkUserId = `user_${crypto.randomUUID()}`;
  createdClerkUserIds.push(clerkUserId);
  return clerkUserId;
}

async function getAdminRows(clerkUserId: string) {
  let rows: Schemas.Admin[] = [];
  await withOwnerDb(async (ownerDb) => {
    rows = await ownerDb.select().from(admins).where(eq(admins.clerkUserId, clerkUserId));
  });
  return rows;
}

async function getMe(clerkUserId: string, sessionEmail = "") {
  return await new AdminsRepo(env).getMe({ clerkUserId, sessionEmail });
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Admins company A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Admins company B ${crypto.randomUUID()}` },
        {
          publicId: Utility.generatePublicId(),
          name: `Admins churned ${crypto.randomUUID()}`,
          status: Schemas.CompanyStatusIntEnum.Churned,
        },
        {
          publicId: Utility.generatePublicId(),
          name: `Admins paused ${crypto.randomUUID()}`,
          status: Schemas.CompanyStatusIntEnum.Paused,
        },
      ])
      .returning({ id: companies.id, publicId: companies.publicId });
    companyA = created[0]!;
    companyB = created[1]!;
    churnedCompany = created[2]!;
    pausedCompany = created[3]!;

    await ownerDb.insert(admins).values([
      { clerkUserId: operatorClerkUserId, companyId: null, email: "op@example.com" },
      { clerkUserId: adminAClerkUserId, companyId: companyA.id, email: "a@example.com" },
      { clerkUserId: churnedAdminClerkUserId, companyId: churnedCompany.id },
      { clerkUserId: pausedAdminClerkUserId, companyId: pausedCompany.id },
    ]);
  });
});

beforeEach(() => {
  clerk.invites.clear();
  clerk.isConsumeFailing = false;
  vi.mocked(ClerkProvider.getAdminProfile).mockClear();
  vi.mocked(ClerkProvider.consumeInvite).mockClear();
});

afterAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(admins).where(inArray(admins.clerkUserId, createdClerkUserIds));
    const companyIds = [companyA.id, companyB.id, churnedCompany.id, pausedCompany.id].filter(
      Boolean,
    );
    if (companyIds.length > 0) {
      await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
    }
  });
});

describe("AdminsRepo.getAdminContext", () => {
  it("derives the operator role from a row with no company", async () => {
    const result = await new AdminsRepo(env).getAdminContext({ clerkUserId: operatorClerkUserId });
    expect(result.isSuccess).toBe(true);
    expect(result.admin?.role).toBe(Schemas.AdminRoleEnum.Operator);
    expect(result.admin?.companyId).toBeNull();
  });

  it("derives the company admin role and company from the row", async () => {
    const result = await new AdminsRepo(env).getAdminContext({ clerkUserId: adminAClerkUserId });
    expect(result.isSuccess).toBe(true);
    expect(result.admin?.role).toBe(Schemas.AdminRoleEnum.CompanyAdmin);
    expect(result.admin?.companyId).toBe(companyA.id);
  });

  it("answers with no admin for an unknown Clerk user, and never provisions", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, companyA.publicId);

    const result = await new AdminsRepo(env).getAdminContext({ clerkUserId });
    expect(result).toEqual({ isSuccess: true, message: "Admin not found" });
    expect(ClerkProvider.getAdminProfile).not.toHaveBeenCalled();
    expect(await getAdminRows(clerkUserId)).toHaveLength(0);
  });

  it("gives no access to an admin of a churned company", async () => {
    const result = await new AdminsRepo(env).getAdminContext({
      clerkUserId: churnedAdminClerkUserId,
    });
    expect(result).toEqual({
      isSuccess: true,
      message: "Company has churned",
      admin: undefined,
    });
  });

  it("keeps access for an admin of a paused company", async () => {
    const result = await new AdminsRepo(env).getAdminContext({
      clerkUserId: pausedAdminClerkUserId,
    });
    expect(result.admin?.companyId).toBe(pausedCompany.id);
  });
});

describe("AdminsRepo.getMe", () => {
  it("returns an existing company admin with their company and no internal ids", async () => {
    const result = await getMe(adminAClerkUserId);
    expect(result.isSuccess).toBe(true);
    expect(result.admin).toMatchObject({
      clerkUserId: adminAClerkUserId,
      email: "a@example.com",
      role: Schemas.AdminRoleEnum.CompanyAdmin,
      company: { publicId: companyA.publicId },
    });
    expect(result.admin).not.toHaveProperty("id");
    expect(result.admin).not.toHaveProperty("companyId");
    expect(ClerkProvider.getAdminProfile).not.toHaveBeenCalled();
  });

  it("returns an existing operator with no company", async () => {
    const result = await getMe(operatorClerkUserId);
    expect(result.isSuccess).toBe(true);
    expect(result.admin?.role).toBe(Schemas.AdminRoleEnum.Operator);
    expect(result.admin?.company).toBeNull();
  });

  it("creates a company admin on first sign-in and consumes the invite", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, companyB.publicId);

    const result = await getMe(clerkUserId);
    expect(result.isSuccess).toBe(true);
    expect(result.admin).toMatchObject({
      clerkUserId,
      email: "invitee@example.com",
      name: "Invited Admin",
      role: Schemas.AdminRoleEnum.CompanyAdmin,
      company: { publicId: companyB.publicId },
    });
    expect(clerk.invites.has(clerkUserId)).toBe(false);

    const rows = await getAdminRows(clerkUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(companyB.id);

    // Second sign-in reads the row; Clerk isn't asked again
    vi.mocked(ClerkProvider.getAdminProfile).mockClear();
    const again = await getMe(clerkUserId);
    expect(again.admin?.company?.publicId).toBe(companyB.publicId);
    expect(ClerkProvider.getAdminProfile).not.toHaveBeenCalled();
  });

  it("really revokes access when the admins row is deleted", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, companyA.publicId);
    expect((await getMe(clerkUserId)).admin).toBeDefined();

    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(admins).where(eq(admins.clerkUserId, clerkUserId));
    });

    // DEV_NOTE: The invite was consumed on first sign-in, so the next load can't re-provision from it
    const after = await getMe(clerkUserId);
    expect(after).toEqual({ isSuccess: true, message: "No dashboard access" });
    expect(await getAdminRows(clerkUserId)).toHaveLength(0);
  });

  it("creates no row and keeps the invite when Clerk can't consume it", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, companyA.publicId);
    clerk.isConsumeFailing = true;

    const result = await getMe(clerkUserId);
    expect(result).toEqual({
      isSuccess: false,
      message: "Unknown error in consuming Clerk invite",
    });
    expect(await getAdminRows(clerkUserId)).toHaveLength(0);
    expect(clerk.invites.get(clerkUserId)).toBe(companyA.publicId);

    // The next load retries and succeeds
    clerk.isConsumeFailing = false;
    expect((await getMe(clerkUserId)).admin?.company?.publicId).toBe(companyA.publicId);
  });

  it("creates one row when two first sign-ins race", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, companyA.publicId);

    const results = await Promise.all([getMe(clerkUserId), getMe(clerkUserId)]);
    for (const result of results) {
      expect(result.isSuccess).toBe(true);
      expect(result.admin?.company?.publicId).toBe(companyA.publicId);
    }
    expect(await getAdminRows(clerkUserId)).toHaveLength(1);
  });

  it("gives no access, and creates nothing, without invite metadata", async () => {
    const clerkUserId = newClerkUserId();

    const result = await getMe(clerkUserId);
    expect(result).toEqual({ isSuccess: true, message: "No dashboard access" });
    // DEV_NOTE: The key case — a sign-in with no company must never become an operator row
    expect(await getAdminRows(clerkUserId)).toHaveLength(0);
  });

  it("gives no access when the invite names a company that doesn't exist", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, Utility.generatePublicId());

    const result = await getMe(clerkUserId);
    expect(result).toEqual({ isSuccess: true, message: "No dashboard access" });
    expect(await getAdminRows(clerkUserId)).toHaveLength(0);
  });

  it("gives no access, and creates nothing, for an invite to a churned company", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, churnedCompany.publicId);

    const result = await getMe(clerkUserId);
    expect(result).toEqual({ isSuccess: true, message: "Company has churned" });
    expect(await getAdminRows(clerkUserId)).toHaveLength(0);
    expect(ClerkProvider.consumeInvite).not.toHaveBeenCalled();
  });

  it("gives an existing admin of a churned company no access", async () => {
    const result = await getMe(churnedAdminClerkUserId);
    expect(result).toEqual({ isSuccess: true, message: "Company has churned" });
  });

  it("fails without creating a row when Clerk can't be reached", async () => {
    const clerkUserId = newClerkUserId();
    vi.mocked(ClerkProvider.getAdminProfile).mockResolvedValueOnce({
      isSuccess: false,
      message: "Unknown error in fetching Clerk user",
    });

    const result = await getMe(clerkUserId);
    expect(result).toEqual({ isSuccess: false, message: "Unknown error in fetching Clerk user" });
    expect(await getAdminRows(clerkUserId)).toHaveLength(0);
  });

  it("updates the stored email from the session, for company admins and operators", async () => {
    const clerkUserId = newClerkUserId();
    clerk.invites.set(clerkUserId, companyB.publicId);
    await getMe(clerkUserId);

    const changed = await getMe(clerkUserId, "changed@example.com");
    expect(changed.admin?.email).toBe("changed@example.com");
    expect((await getAdminRows(clerkUserId))[0]?.email).toBe("changed@example.com");

    // An empty session email (claim not configured) leaves the stored one
    const unchanged = await getMe(clerkUserId, "");
    expect(unchanged.admin?.email).toBe("changed@example.com");

    const operator = await getMe(operatorClerkUserId, "op-new@example.com");
    expect(operator.admin?.email).toBe("op-new@example.com");
    expect((await getAdminRows(operatorClerkUserId))[0]?.email).toBe("op-new@example.com");
  });
});

describe("AdminsDAL (cross-company, as diletta_app)", () => {
  it("never moves an admin of company A into company B", async () => {
    const dal = new AdminsDAL();
    const result = await withTenant(getDbClient(env), companyB.id, async (tx) => {
      return await dal.createAdmin(tx, {
        clerkUserId: adminAClerkUserId,
        companyId: companyB.id,
        email: null,
        name: null,
      });
    });
    expect(result.isSuccess).toBe(false);

    const rows = await getAdminRows(adminAClerkUserId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(companyA.id);
  });

  it("never claims an operator's Clerk user for a company", async () => {
    const dal = new AdminsDAL();
    const result = await withTenant(getDbClient(env), companyA.id, async (tx) => {
      return await dal.createAdmin(tx, {
        clerkUserId: operatorClerkUserId,
        companyId: companyA.id,
        email: null,
        name: null,
      });
    });
    expect(result.isSuccess).toBe(false);
    expect((await getAdminRows(operatorClerkUserId))[0]?.companyId).toBeNull();
  });

  it("refuses an admin for a company that does not exist", async () => {
    const dal = new AdminsDAL();
    // DEV_NOTE: identity ids start at 1, so 0 never references a company
    const result = await withTenant(getDbClient(env), "0", async (tx) => {
      return await dal.createAdmin(tx, {
        clerkUserId: newClerkUserId(),
        companyId: "0",
        email: null,
        name: null,
      });
    });
    expect(result).toEqual({ isSuccess: false, message: "Company not found" });
  });

  it("can't read company A's admin from inside company B", async () => {
    const dal = new AdminsDAL();
    const result: Schemas.AdminDALResponse = await withTenant(
      getDbClient(env),
      companyB.id,
      async (tx) => {
        return await dal.getAdminByClerkUserId(tx, { clerkUserId: adminAClerkUserId });
      },
    );
    expect(result).toEqual({ isSuccess: false, message: "Admin not found", isNotFound: true });
  });

  it("can't update company A's admin email from inside company B", async () => {
    const [adminA] = await getAdminRows(adminAClerkUserId);
    const dal = new AdminsDAL();
    const result = await withTenant(getDbClient(env), companyB.id, async (tx) => {
      return await dal.updateAdminEmail(tx, {
        adminId: adminA!.id,
        companyId: companyB.id,
        email: "hijacked@example.com",
      });
    });
    expect(result.isSuccess).toBe(false);
    expect((await getAdminRows(adminAClerkUserId))[0]?.email).toBe("a@example.com");
  });
});

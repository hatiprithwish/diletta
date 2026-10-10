import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import { companies, companyConnections, toolDefinitions } from "@/db/tables";
import ToolDefinitionsRepo from "@/repositories/ToolDefinitionsRepo";
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

// DEV_NOTE: Tests hit the Neon staging branch. Two fresh companies per run, each with a connection; the Repo runs as
// diletta_app (HYPERDRIVE), so RLS applies. Fixtures and cleanup run as the owner.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
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

function connectionValues(companyId: string) {
  return {
    publicId: Utility.generatePublicId(),
    companyId,
    environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
    baseUrl: "https://host.example.com",
    authType: "jwt_forward",
    authConfig: {},
    credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
    jwtIssuer: `https://${crypto.randomUUID()}.example.com`,
    allowedOrigins: ["https://host.example.com"],
  };
}

function writeOps(): Schemas.ToolOpsInput {
  return {
    inputSchema: {
      type: "object",
      properties: { recordId: { type: "string" }, amount: { type: "number" } },
      required: ["recordId", "amount"],
    },
    callOp: {
      method: Schemas.ToolOpMethodEnum.Patch,
      path: "/records/{args.recordId}",
      bodyMap: { amount: "{args.amount}" },
    },
    readbackOp: {
      method: Schemas.ToolOpMethodEnum.Get,
      path: "/records/{args.recordId}",
      compare: { amount: "data.amount" },
    },
    inverseOp: {
      method: Schemas.ToolOpMethodEnum.Patch,
      path: "/records/{args.recordId}",
      bodyMap: { amount: "{before.data.amount}" },
    },
  };
}

function writeTool(name: string, connectionPublicId: string) {
  return {
    connectionPublicId,
    name,
    description: "Update a record's amount",
    risk: Schemas.ToolDefinitionRiskIntEnum.Write,
    idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.Emulated,
    approval: Schemas.ToolDefinitionApprovalIntEnum.Policy,
    source: Schemas.ToolDefinitionSourceIntEnum.Manual,
    ops: Schemas.ZToolOps.parse(writeOps()),
  };
}

const uniqueName = () => `update_amount_${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Tools A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Tools B ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    companyA = created[0]!.id;
    companyB = created[1]!.id;
    const connections = await ownerDb
      .insert(companyConnections)
      .values([connectionValues(companyA), connectionValues(companyB)])
      .returning({ publicId: companyConnections.publicId });
    connectionA = connections[0]!.publicId;
    connectionB = connections[1]!.publicId;
  });
});

afterAll(async () => {
  const companyIds = [companyA, companyB].filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(toolDefinitions).where(inArray(toolDefinitions.companyId, companyIds));
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("ToolDefinitionsRepo", () => {
  it("creates version 1 as a Draft with labels, loaded ops and no internal ids", async () => {
    const repo = new ToolDefinitionsRepo(env);
    const name = uniqueName();

    const created = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(name, connectionA),
    });
    expect(created.isSuccess).toBe(true);
    const tool = created.toolDefinition!;
    expect(tool.version).toBe(1);
    expect(tool.schemaVersion).toBe(Schemas.CURRENT_TOOL_OPS_SCHEMA_VERSION);
    expect(tool.connectionPublicId).toBe(connectionA);
    expect(tool.toolDefinitionStatus).toBe(Schemas.ToolDefinitionStatusIntEnum.Draft);
    expect(tool.toolDefinitionStatusLabel).toBe(Schemas.ToolDefinitionStatusLabelEnum.Draft);
    expect(tool.riskLabel).toBe(Schemas.ToolDefinitionRiskLabelEnum.Write);
    expect(tool.idempotencyModeLabel).toBe(Schemas.ToolDefinitionIdempotencyModeLabelEnum.Emulated);
    expect(tool.approvalLabel).toBe(Schemas.ToolDefinitionApprovalLabelEnum.Policy);
    expect(tool.sourceLabel).toBe(Schemas.ToolDefinitionSourceLabelEnum.Manual);
    expect(tool.ops.callOp.path).toBe("/records/{args.recordId}");
    for (const key of ["id", "companyId", "connectionId", "createdBy", "updatedBy", "callOp"]) {
      expect(tool).not.toHaveProperty(key);
    }

    const fetched = await repo.getToolDefinitionDetails({
      companyId: companyA,
      publicId: tool.publicId,
    });
    expect(fetched.toolDefinition?.name).toBe(name);

    const listed = await repo.getToolDefinitions({ companyId: companyA, name });
    expect(listed.toolDefinitions?.map((item) => item.publicId)).toEqual([tool.publicId]);
    const counted = await repo.getToolDefinitionsCount({ companyId: companyA, name });
    expect(counted.totalRecords).toBe(1);
  });

  it("refuses a second tool with the same name, an unknown connection and ops that don't fit the risk", async () => {
    const repo = new ToolDefinitionsRepo(env);
    const name = uniqueName();
    await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(name, connectionA),
    });

    const again = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(name, connectionA),
    });
    expect(again.failure).toBe(Schemas.ToolDefinitionFailureEnum.NameTaken);

    // DEV_NOTE: Company B's connection is not one of company A's
    const foreign = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(uniqueName(), connectionB),
    });
    expect(foreign.failure).toBe(Schemas.ToolDefinitionFailureEnum.ConnectionNotFound);

    const readWithReadback = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: {
        ...writeTool(uniqueName(), connectionA),
        risk: Schemas.ToolDefinitionRiskIntEnum.Read,
      },
    });
    expect(readWithReadback).toEqual({
      isSuccess: false,
      message: "A read tool has no readback op",
      failure: Schemas.ToolDefinitionFailureEnum.InvalidOps,
    });
  });

  it("edits a Draft only, re-checking the risk against the stored ops", async () => {
    const repo = new ToolDefinitionsRepo(env);
    const created = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(uniqueName(), connectionA),
    });
    const publicId = created.toolDefinition!.publicId;

    const edited = await repo.updateToolDefinition({
      companyId: companyA,
      publicId,
      adminId: "1",
      toolDefinition: {
        description: "Set the amount",
        ops: { ...Schemas.ZToolOps.parse(writeOps()), inverseOp: null },
      },
    });
    expect(edited.isSuccess).toBe(true);
    expect(edited.toolDefinition?.description).toBe("Set the amount");
    expect(edited.toolDefinition?.ops.inverseOp).toBeNull();
    expect(edited.toolDefinition?.ops.readbackOp?.compare).toEqual({ amount: "data.amount" });

    const readRisk = await repo.updateToolDefinition({
      companyId: companyA,
      publicId,
      adminId: "1",
      toolDefinition: { risk: Schemas.ToolDefinitionRiskIntEnum.Read },
    });
    expect(readRisk.failure).toBe(Schemas.ToolDefinitionFailureEnum.InvalidOps);

    const activated = await repo.setToolDefinitionStatus({
      companyId: companyA,
      publicId,
      adminId: "1",
      status: Schemas.ToolDefinitionStatusIntEnum.Active,
    });
    expect(activated.toolDefinition?.toolDefinitionStatus).toBe(
      Schemas.ToolDefinitionStatusIntEnum.Active,
    );

    const editActive = await repo.updateToolDefinition({
      companyId: companyA,
      publicId,
      adminId: "1",
      toolDefinition: { description: "Changed after activation" },
    });
    expect(editActive.failure).toBe(Schemas.ToolDefinitionFailureEnum.NotDraft);
    const deleteActive = await repo.deleteToolDefinition({ companyId: companyA, publicId });
    expect(deleteActive.failure).toBe(Schemas.ToolDefinitionFailureEnum.NotDraft);
  });

  it("creates new versions as Drafts, one Draft per name, and walks the status transitions", async () => {
    const repo = new ToolDefinitionsRepo(env);
    const name = uniqueName();
    const created = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(name, connectionA),
    });
    const v1 = created.toolDefinition!.publicId;

    const whileDraft = await repo.createToolDefinitionVersion({
      companyId: companyA,
      publicId: v1,
      adminId: "1",
    });
    expect(whileDraft.failure).toBe(Schemas.ToolDefinitionFailureEnum.DraftExists);

    const draftToDisabled = await repo.setToolDefinitionStatus({
      companyId: companyA,
      publicId: v1,
      adminId: "1",
      status: Schemas.ToolDefinitionStatusIntEnum.Disabled,
    });
    expect(draftToDisabled.failure).toBe(Schemas.ToolDefinitionFailureEnum.InvalidTransition);

    const statuses: Schemas.SetToolDefinitionStatusApiRequest["status"][] = [
      Schemas.ToolDefinitionStatusIntEnum.Active,
      Schemas.ToolDefinitionStatusIntEnum.Active,
      Schemas.ToolDefinitionStatusIntEnum.Disabled,
    ];
    for (const status of statuses) {
      const result = await repo.setToolDefinitionStatus({
        companyId: companyA,
        publicId: v1,
        adminId: "1",
        status,
      });
      expect(result.toolDefinition?.toolDefinitionStatus).toBe(status);
    }

    const v2 = await repo.createToolDefinitionVersion({
      companyId: companyA,
      publicId: v1,
      adminId: "1",
    });
    expect(v2.isSuccess).toBe(true);
    expect(v2.toolDefinition?.version).toBe(2);
    expect(v2.toolDefinition?.name).toBe(name);
    expect(v2.toolDefinition?.toolDefinitionStatus).toBe(Schemas.ToolDefinitionStatusIntEnum.Draft);
    expect(v2.toolDefinition?.ops).toEqual(created.toolDefinition?.ops);

    const deleted = await repo.deleteToolDefinition({
      companyId: companyA,
      publicId: v2.toolDefinition!.publicId,
    });
    expect(deleted.isSuccess).toBe(true);

    const v3 = await repo.createToolDefinitionVersion({
      companyId: companyA,
      publicId: v1,
      adminId: "1",
    });
    // DEV_NOTE: The deleted Draft's number is free again: the next version is the highest that exists + 1
    expect(v3.toolDefinition?.version).toBe(2);
  });

  it("keeps several versions of one name Active at once: activating v2 leaves v1 Active", async () => {
    const repo = new ToolDefinitionsRepo(env);
    const name = uniqueName();
    const created = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(name, connectionA),
    });
    const v1 = created.toolDefinition!.publicId;
    const active = Schemas.ToolDefinitionStatusIntEnum.Active;
    await repo.setToolDefinitionStatus({
      companyId: companyA,
      publicId: v1,
      adminId: "1",
      status: active,
    });

    const v2 = await repo.createToolDefinitionVersion({
      companyId: companyA,
      publicId: v1,
      adminId: "1",
    });
    const activated = await repo.setToolDefinitionStatus({
      companyId: companyA,
      publicId: v2.toolDefinition!.publicId,
      adminId: "1",
      status: active,
    });
    expect(activated.toolDefinition?.toolDefinitionStatus).toBe(active);

    const listed = await repo.getToolDefinitions({ companyId: companyA, name, status: active });
    expect(listed.toolDefinitions?.map((tool) => tool.version).sort()).toEqual([1, 2]);
  });

  it("refuses a disabled or non-REST connection on create, and activation once it is disabled", async () => {
    const repo = new ToolDefinitionsRepo(env);
    let disabled = "";
    let hostExec = "";
    let later = "";
    await withOwnerDb(async (ownerDb) => {
      const rows = await ownerDb
        .insert(companyConnections)
        .values([
          {
            ...connectionValues(companyA),
            status: Schemas.CompanyConnectionStatusIntEnum.Disabled,
          },
          {
            ...connectionValues(companyA),
            adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.HostExec,
            baseUrl: null,
          },
          connectionValues(companyA),
        ])
        .returning({ publicId: companyConnections.publicId });
      disabled = rows[0]!.publicId;
      hostExec = rows[1]!.publicId;
      later = rows[2]!.publicId;
    });

    for (const connectionPublicId of [disabled, hostExec]) {
      const refused = await repo.createToolDefinition({
        companyId: companyA,
        adminId: "1",
        toolDefinition: writeTool(uniqueName(), connectionPublicId),
      });
      expect(refused.failure).toBe(Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable);
    }

    const created = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(uniqueName(), later),
    });
    const moved = await repo.updateToolDefinition({
      companyId: companyA,
      publicId: created.toolDefinition!.publicId,
      adminId: "1",
      toolDefinition: { connectionPublicId: disabled },
    });
    expect(moved.failure).toBe(Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable);

    await withOwnerDb(async (ownerDb) => {
      await ownerDb
        .update(companyConnections)
        .set({ status: Schemas.CompanyConnectionStatusIntEnum.Disabled })
        .where(eq(companyConnections.publicId, later));
    });
    const activated = await repo.setToolDefinitionStatus({
      companyId: companyA,
      publicId: created.toolDefinition!.publicId,
      adminId: "1",
      status: Schemas.ToolDefinitionStatusIntEnum.Active,
    });
    expect(activated.failure).toBe(Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable);
  });

  it("refuses to activate a version whose connection is gone", async () => {
    const repo = new ToolDefinitionsRepo(env);
    let doomed = "";
    await withOwnerDb(async (ownerDb) => {
      const [connection] = await ownerDb
        .insert(companyConnections)
        .values(connectionValues(companyA))
        .returning({ publicId: companyConnections.publicId });
      doomed = connection!.publicId;
    });
    const created = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(uniqueName(), doomed),
    });
    await withOwnerDb(async (ownerDb) => {
      await ownerDb.delete(companyConnections).where(eq(companyConnections.publicId, doomed));
    });

    const fetched = await repo.getToolDefinitionDetails({
      companyId: companyA,
      publicId: created.toolDefinition!.publicId,
    });
    expect(fetched.toolDefinition?.connectionPublicId).toBeNull();

    const activated = await repo.setToolDefinitionStatus({
      companyId: companyA,
      publicId: created.toolDefinition!.publicId,
      adminId: "1",
      status: Schemas.ToolDefinitionStatusIntEnum.Active,
    });
    expect(activated.failure).toBe(Schemas.ToolDefinitionFailureEnum.ConnectionNotFound);
  });

  it("never reads or writes another company's tool definition", async () => {
    const repo = new ToolDefinitionsRepo(env);
    const name = uniqueName();
    const created = await repo.createToolDefinition({
      companyId: companyA,
      adminId: "1",
      toolDefinition: writeTool(name, connectionA),
    });
    const publicId = created.toolDefinition!.publicId;
    const asB = { companyId: companyB, publicId };

    expect((await repo.getToolDefinitionDetails(asB)).isNotFound).toBe(true);
    expect((await repo.getToolDefinitions({ companyId: companyB, name })).toolDefinitions).toEqual(
      [],
    );
    expect((await repo.getToolDefinitionsCount({ companyId: companyB, name })).totalRecords).toBe(
      0,
    );
    expect(
      (
        await repo.updateToolDefinition({
          ...asB,
          adminId: "1",
          toolDefinition: { description: "x" },
        })
      ).isNotFound,
    ).toBe(true);
    expect((await repo.createToolDefinitionVersion({ ...asB, adminId: "1" })).isNotFound).toBe(
      true,
    );
    expect(
      (
        await repo.setToolDefinitionStatus({
          ...asB,
          adminId: "1",
          status: Schemas.ToolDefinitionStatusIntEnum.Active,
        })
      ).isNotFound,
    ).toBe(true);
    expect((await repo.deleteToolDefinition(asB)).isNotFound).toBe(true);

    // DEV_NOTE: The same name is free in company B: names are per company
    const sameName = await repo.createToolDefinition({
      companyId: companyB,
      adminId: "1",
      toolDefinition: writeTool(name, connectionB),
    });
    expect(sameName.isSuccess).toBe(true);

    const untouched = await repo.getToolDefinitionDetails({ companyId: companyA, publicId });
    expect(untouched.toolDefinition?.toolDefinitionStatus).toBe(
      Schemas.ToolDefinitionStatusIntEnum.Draft,
    );
  });
});

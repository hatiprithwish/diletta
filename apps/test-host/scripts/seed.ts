import { parseArgs } from "node:util";
import pg from "pg";
import * as Schemas from "@app/schemas";
// DEV_NOTE: The backend's own publicId generator, so seeded rows get ids made like every other
import Utility from "../../backend/src/utils/Utility.ts";
import { readOwnerDatabaseUrl } from "../../backend/src/db/ownerDatabaseUrl.ts";

// DEV_NOTE: Puts the test host on our test company (docs/runbooks/test-host.md). Idempotent: rerun it after changing
// Schemas.TEST_HOST_TOOL_DEFINITIONS.
//   pnpm --filter test-host seed --company <companyPublicId> [--issuer <url>]
// The company must exist already (operator API: that is what creates its encryption key). The issuer defaults to the
// staging test host (Schemas.TEST_HOST_STAGING_ISSUER). On the database in apps/backend/.env (the staging branch), as
// the owner role (DATABASE_URL): fixture setup, like a test's, never code under test.
// 1. The issuer's staging company connection: REST, base_url {issuer}/v1/, jwt_forward, the widget dev host's origin
//    allowed. Created Active on the first run. On a rerun only base_url is set and the dev origin added: an operator's
//    status and other origins are kept, and a row whose fixed-at-create fields differ (another environment, adapter,
//    auth type or scope) is refused, never rewritten. Refused if the issuer belongs to another company.
// 2. Each tool definition, Active at its newest version: a new version is added only when the definition changed, so
//    configs pinned to an older version keep it. Refused while a Draft of the name exists (an operator is editing it).
//    Skipped while the connection isn't Active (a tool needs an Active connection), with a message saying so.
// 3. Says what a chat with the tools still needs, and the {name, version} pins for the config.
// reset_op stays null: its shape is defined by the eval reset flow (M5-2), which sets it here, pointing at
// POST /v1/_reset.

// DEV_NOTE: The connection id, and whether it is Active (a tool can be activated only on an Active connection)
async function upsertConnection(
  client: pg.Client,
  companyId: string,
  issuer: string,
): Promise<{ connectionId: string; isActive: boolean }> {
  const baseUrl = Schemas.getTestHostBaseUrl(issuer);
  const existing = await client.query<Schemas.TestHostSeedConnectionRow>(
    `SELECT id, company_id, environment, adapter_type, auth_type, credential_scope, status, allowed_origins
       FROM company_connections WHERE jwt_issuer = $1 FOR UPDATE`,
    [issuer],
  );
  const row = existing.rows[0];
  if (row && row.company_id !== companyId) {
    throw new Error(`Issuer ${issuer} is already another company's connection`);
  }
  if (row) {
    if (
      row.environment !== Schemas.CompanyConnectionEnvironmentIntEnum.Staging ||
      row.adapter_type !== Schemas.CompanyConnectionAdapterTypeIntEnum.Rest ||
      row.auth_type !== Schemas.CompanyConnectionAuthTypeEnum.JwtForward ||
      row.credential_scope !== Schemas.CompanyConnectionCredentialScopeIntEnum.None
    ) {
      throw new Error(
        `Connection for ${issuer} isn't a staging REST jwt_forward connection; replace it with a new one`,
      );
    }
    const origins = row.allowed_origins.includes(Schemas.WIDGET_DEV_ORIGIN)
      ? row.allowed_origins
      : [...row.allowed_origins, Schemas.WIDGET_DEV_ORIGIN];
    await client.query(
      `UPDATE company_connections SET base_url = $1, allowed_origins = $2, updated_at = now() WHERE id = $3`,
      [baseUrl, origins, row.id],
    );
    return {
      connectionId: row.id,
      isActive: row.status === Schemas.CompanyConnectionStatusIntEnum.Active,
    };
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO company_connections
       (public_id, company_id, environment, adapter_type, base_url, auth_type, auth_config, credential_scope,
        jwt_issuer, allowed_origins, status)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, $8, $9, $10)
     RETURNING id`,
    [
      Utility.generatePublicId(),
      companyId,
      Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
      Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
      baseUrl,
      Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      issuer,
      [Schemas.WIDGET_DEV_ORIGIN],
      Schemas.CompanyConnectionStatusIntEnum.Active,
    ],
  );
  return { connectionId: inserted.rows[0]!.id, isActive: true };
}

// DEV_NOTE: JSON with sorted keys, so a stored jsonb (key order not kept) compares equal to the definition
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isSameDefinition(
  row: Schemas.TestHostSeedToolRow,
  connectionId: string,
  tool: Schemas.TestHostToolDefinition,
  ops: Schemas.ToolOps,
  schemaVersion: number,
): boolean {
  return (
    row.connection_id === connectionId &&
    row.description === tool.description &&
    row.risk === tool.risk &&
    row.idempotency_mode === tool.idempotencyMode &&
    row.approval === tool.approval &&
    row.source === tool.source &&
    row.schema_version === schemaVersion &&
    canonical([row.input_schema, row.call_op, row.readback_op, row.inverse_op]) ===
      canonical([ops.inputSchema, ops.callOp, ops.readbackOp, ops.inverseOp])
  );
}

async function seedTool(
  client: pg.Client,
  companyId: string,
  connectionId: string,
  tool: Schemas.TestHostToolDefinition,
): Promise<{ name: string; version: number; change: string }> {
  const riskIssue = Schemas.getToolRiskOpsIssue(tool.risk, tool.idempotencyMode, tool.ops);
  const normalized = Schemas.normalizeToolOps(tool.ops);
  if (riskIssue || !normalized.ops || normalized.schemaVersion === undefined) {
    throw new Error(`Tool ${tool.name} is invalid: ${riskIssue ?? normalized.message}`);
  }
  const { ops, schemaVersion } = normalized;

  // DEV_NOTE: The same advisory lock as ToolDefinitionsDAL's new version, so a seed can't race an operator's edit
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `tool_definition:${companyId}:${tool.name}`,
  ]);
  const rows = await client.query<Schemas.TestHostSeedToolRow>(
    `SELECT id, version, status, connection_id, description, risk, idempotency_mode, approval, source,
            schema_version, input_schema, call_op, readback_op, inverse_op
       FROM tool_definitions WHERE company_id = $1 AND name = $2 ORDER BY version DESC`,
    [companyId, tool.name],
  );
  if (rows.rows.some((row) => row.status === Schemas.ToolDefinitionStatusIntEnum.Draft)) {
    throw new Error(`Tool ${tool.name} has a Draft version: activate or delete it first`);
  }

  const latest = rows.rows[0];
  if (latest && isSameDefinition(latest, connectionId, tool, ops, schemaVersion)) {
    if (latest.status === Schemas.ToolDefinitionStatusIntEnum.Active) {
      return { name: tool.name, version: latest.version, change: "unchanged" };
    }
    await client.query(
      "UPDATE tool_definitions SET status = $1, updated_at = now() WHERE id = $2",
      [Schemas.ToolDefinitionStatusIntEnum.Active, latest.id],
    );
    return { name: tool.name, version: latest.version, change: "re-activated" };
  }

  const version = (latest?.version ?? 0) + 1;
  await client.query(
    `INSERT INTO tool_definitions
       (public_id, company_id, connection_id, name, version, description, risk, schema_version, input_schema,
        call_op, readback_op, inverse_op, idempotency_mode, approval, source, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      Utility.generatePublicId(),
      companyId,
      connectionId,
      tool.name,
      version,
      tool.description,
      tool.risk,
      schemaVersion,
      JSON.stringify(ops.inputSchema),
      JSON.stringify(ops.callOp),
      ops.readbackOp === null ? null : JSON.stringify(ops.readbackOp),
      ops.inverseOp === null ? null : JSON.stringify(ops.inverseOp),
      tool.idempotencyMode,
      tool.approval,
      tool.source,
      Schemas.ToolDefinitionStatusIntEnum.Active,
    ],
  );
  return { name: tool.name, version, change: latest ? "new version" : "created" };
}

// DEV_NOTE: What a chat with these tools needs that the seed doesn't make: reported, not created
async function reportGaps(client: pg.Client, companyId: string): Promise<string[]> {
  const gaps: string[] = [];
  const chatbot = await client.query<{ id: string }>(
    "SELECT id FROM chatbots WHERE company_id = $1 AND is_default AND status = $2",
    [companyId, Schemas.ChatbotStatusIntEnum.Active],
  );
  const chatbotId = chatbot.rows[0]?.id;
  if (!chatbotId) {
    gaps.push("an active default chatbot");
  } else {
    const config = await client.query(
      "SELECT 1 FROM chatbot_configs WHERE chatbot_id = $1 AND status = $2",
      [chatbotId, Schemas.ChatbotConfigStatusIntEnum.Published],
    );
    if (config.rowCount === 0) gaps.push("a published config for the default chatbot");
  }
  const modelKey = await client.query(
    "SELECT 1 FROM company_secrets WHERE company_id = $1 AND type = $2 AND status = $3",
    [
      companyId,
      Schemas.CompanySecretTypeIntEnum.ModelKey,
      Schemas.CompanySecretStatusIntEnum.Active,
    ],
  );
  if (modelKey.rowCount === 0) gaps.push("an active model key");
  return gaps;
}

async function main() {
  const { values } = parseArgs({
    options: { company: { type: "string" }, issuer: { type: "string" } },
  });
  if (!values.company) {
    throw new Error(
      "Usage: pnpm --filter test-host seed --company <companyPublicId> [--issuer <url>]",
    );
  }
  const issuer = (values.issuer ?? Schemas.TEST_HOST_STAGING_ISSUER).replace(/\/+$/, "");
  if (!issuer.startsWith("https://")) throw new Error("The issuer must be an https URL");

  const client = new pg.Client({ connectionString: readOwnerDatabaseUrl() });
  await client.connect();
  try {
    const company = await client.query<{ id: string; status: number }>(
      "SELECT id, status FROM companies WHERE public_id = $1",
      [values.company],
    );
    const companyRow = company.rows[0];
    if (!companyRow) throw new Error(`No company with publicId ${values.company}`);
    if (companyRow.status !== Schemas.CompanyStatusIntEnum.Active) {
      throw new Error(`Company ${values.company} is not active`);
    }

    await client.query("BEGIN");
    const { connectionId, isActive } = await upsertConnection(client, companyRow.id, issuer);
    const seeded = [];
    if (isActive) {
      for (const tool of Schemas.TEST_HOST_TOOL_DEFINITIONS) {
        seeded.push(await seedTool(client, companyRow.id, connectionId, tool));
      }
    }
    await client.query("COMMIT");

    if (!isActive) {
      process.stdout.write(
        `The test host connection for ${issuer} is disabled: left as it is, no tools seeded. Enable it to seed.\n`,
      );
      return;
    }

    const gaps = await reportGaps(client, companyRow.id);
    process.stdout.write(
      [
        `Test host ${issuer} is connected to company ${values.company}.`,
        ...seeded.map(({ name, version, change }) => `  ${name} v${version}: ${change}`),
        "Pin these in the chatbot's config (tools):",
        JSON.stringify(seeded.map(({ name, version }) => ({ name, version }))),
        gaps.length > 0
          ? `Before the chatbot can use them, the company still needs: ${gaps.join(", ")}.`
          : "The company has everything a chat needs.",
        "",
      ].join("\n"),
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

await main();

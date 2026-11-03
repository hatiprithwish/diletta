import type pg from "pg";
import * as Schemas from "@app/schemas";
import Utility from "../utils/Utility";

// DEV_NOTE: Dev scripts only (`pnpm --filter test-host seed`, `pnpm --filter backend eregister:tools`), never the
// worker or code under test: stores a host's tool definitions on its connection as the owner role, in the caller's
// transaction. Each tool ends Active at its newest version, and a new version is added only when the definition
// changed, so configs pinned to an older version keep it. Refused while a Draft of the name exists (an operator is
// editing it).

// DEV_NOTE: JSON with sorted keys, so a stored jsonb (key order not kept) compares equal to the definition
export function canonical(value: unknown): string {
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
  row: Schemas.ToolDefinitionSeedRow,
  connectionId: string,
  tool: Schemas.ToolDefinitionSeed,
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

export async function seedToolDefinition(
  client: pg.Client,
  companyId: string,
  connectionId: string,
  tool: Schemas.ToolDefinitionSeed,
): Promise<{ name: string; version: number; change: string }> {
  const normalized = Schemas.normalizeToolOps(tool.ops);
  if (!normalized.ops || normalized.schemaVersion === undefined) {
    throw new Error(`Tool ${tool.name} is invalid: ${normalized.message}`);
  }
  const { ops, schemaVersion } = normalized;
  // DEV_NOTE: The same check a save or an activation runs (risk rule + an input_schema the runtime can check)
  const issue = Schemas.getToolOpsIssue(tool.risk, tool.idempotencyMode, ops);
  if (issue) throw new Error(`Tool ${tool.name} is invalid: ${issue}`);

  // DEV_NOTE: The same advisory lock as ToolDefinitionsDAL's new version, so a seed can't race an operator's edit
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `tool_definition:${companyId}:${tool.name}`,
  ]);
  const rows = await client.query<Schemas.ToolDefinitionSeedRow>(
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

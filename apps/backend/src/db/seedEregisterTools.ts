import { parseArgs } from "node:util";
import pg from "pg";
import * as Schemas from "@app/schemas";
import { readOwnerDatabaseUrl } from "./ownerDatabaseUrl";
import { seedToolDefinition } from "./seedToolDefinitions";

// DEV_NOTE: Stores eRegister's tools (Schemas.EREGISTER_TOOL_DEFINITIONS, M7-2) on its connection
// (docs/runbooks/eregister.md). Idempotent: rerun after changing the tools or regenerating their input schemas.
//   pnpm --filter backend eregister:tools --company <companyPublicId> --connection <connectionPublicId>
// On the database in apps/backend/.env (the staging branch), as the owner role, like the test host's seed: setup run
// by a person, never code under test, and so not audited. The connection must be the company's and Active (operator
// API, M7-1); it is never changed here. Prints the {name, version} pins for the chatbot's config.

async function main() {
  const { values } = parseArgs({
    options: { company: { type: "string" }, connection: { type: "string" } },
  });
  if (!values.company || !values.connection) {
    throw new Error(
      "Usage: pnpm --filter backend eregister:tools --company <companyPublicId> --connection <connectionPublicId>",
    );
  }

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
    const connection = await client.query<{ id: string; status: number }>(
      "SELECT id, status FROM company_connections WHERE public_id = $1 AND company_id = $2 FOR SHARE",
      [values.connection, companyRow.id],
    );
    const connectionRow = connection.rows[0];
    if (!connectionRow) {
      throw new Error(`Company ${values.company} has no connection ${values.connection}`);
    }
    if (connectionRow.status !== Schemas.CompanyConnectionStatusIntEnum.Active) {
      throw new Error(
        `Connection ${values.connection} isn't Active: a tool needs an Active connection`,
      );
    }

    const seeded = [];
    for (const tool of Schemas.EREGISTER_TOOL_DEFINITIONS) {
      seeded.push(await seedToolDefinition(client, companyRow.id, connectionRow.id, tool));
    }
    await client.query("COMMIT");

    process.stdout.write(
      [
        `eRegister tools on connection ${values.connection} of company ${values.company}:`,
        ...seeded.map(({ name, version, change }) => `  ${name} v${version}: ${change}`),
        "Pin these in the chatbot's config (tools):",
        JSON.stringify(seeded.map(({ name, version }) => ({ name, version }))),
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

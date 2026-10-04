import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// DEV_NOTE: Hyperdrive owns the real connection pool. Create a fresh client per request;
// max 5 stays under the Workers limit on concurrent external connections.
export default function getDbClient(env: Env) {
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 });
  return drizzle({ client: pool });
}

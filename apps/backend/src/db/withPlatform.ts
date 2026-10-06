import { sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import { TenantRollbackError } from "@/db/withTenant";

// DEV_NOTE: The cross-company counterpart of withTenant. Opens one transaction and sets app.is_platform with
// set_config(…, true): transaction-local, so it resets on COMMIT/ROLLBACK and never leaks on a pooled connection.
// Every RLS policy lets it through, so it reads and writes every company's rows. Use it only where no single
// company applies: operator routes, cross-company Cron sweeps, and the lookups that resolve a company before
// withTenant can run (Clerk admin → company, JWT issuer → company_connections). Anything scoped to one company
// uses withTenant. Throw TenantRollbackError to roll back, same as withTenant.
export default async function withPlatform<T extends Schemas.ApiResponse>(
  db: NodePgDatabase,
  callback: (tx: NodePgTransaction<EmptyRelations>) => Promise<T>,
): Promise<T | Schemas.ApiResponse> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.is_platform', 'on', true)`);
      return await callback(tx);
    });
  } catch (error) {
    if (error instanceof TenantRollbackError) {
      return { isSuccess: false, message: error.message };
    }

    const message = "Unknown error in platform transaction";
    AppLogger.error({
      category: Schemas.LogCategory.DB,
      action: Schemas.LogAction.WithPlatform,
      message,
      error,
    });
    return { isSuccess: false, message };
  }
}

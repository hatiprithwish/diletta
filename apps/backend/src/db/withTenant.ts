import { sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: Thrown inside a withTenant callback to roll the whole transaction back. Its message is
// returned to the caller as-is, so throw it with the failed DAL response's message (already logged by the DAL).
export class TenantRollbackError extends Error {
  constructor(message = "Transaction rolled back") {
    super(message);
    this.name = "TenantRollbackError";
  }
}

// DEV_NOTE: companies.id is a bigint identity: canonical decimal (no sign, no leading zeros), at most int64 max.
// Anything else ('' included) would set a context the RLS `::bigint` cast can't read, so it never reaches set_config.
const COMPANY_ID_PATTERN = /^(0|[1-9]\d{0,18})$/;
// DEV_NOTE: Only 19-digit ids can exceed it; same-length digit strings compare like numbers
const INT64_MAX = "9223372036854775807";
// DEV_NOTE: A caller bug can pass anything (a publicId, a serialized object), so only a prefix is logged
const LOGGED_ID_MAX_LENGTH = 32;

// DEV_NOTE: Runs on every tenant call, so it stays cheap: a regex and at most one string compare.
// companyId is typed string, but an untyped caller (a parsed payload, a lookup that found nothing)
// can still pass undefined or null at runtime, hence the typeof check.
function isValidCompanyId(companyId: string): boolean {
  return (
    typeof companyId === "string" &&
    COMPANY_ID_PATTERN.test(companyId) &&
    !(companyId.length === INT64_MAX.length && companyId > INT64_MAX)
  );
}

// DEV_NOTE: Reject path only, for the log
function describeInvalidCompanyId(companyId: string): string {
  if (typeof companyId !== "string") return "not a string";
  if (companyId === "") return "empty";
  if (!COMPANY_ID_PATTERN.test(companyId)) return "not a canonical integer";
  return "out of int64 range";
}

// DEV_NOTE: The only way to run a tenant query. Opens one transaction and sets app.company_id with
// set_config(…, true): transaction-local, so it resets on COMMIT/ROLLBACK and never leaks to the next
// request on a pooled connection. companyId is the internal companies.id, never a client-supplied value.
// RLS policies (M1-3) read current_setting('app.company_id'). The worker currently connects as the
// table owner with BYPASSRLS, so policies only take effect once Hyperdrive uses a non-owner app role.
export default async function withTenant<T extends Schemas.ApiResponse>(
  db: NodePgDatabase,
  companyId: string,
  callback: (tx: NodePgTransaction<EmptyRelations>) => Promise<T>,
): Promise<T | Schemas.ApiResponse> {
  if (!isValidCompanyId(companyId)) {
    const message = "Invalid company id";
    AppLogger.error({
      category: Schemas.LogCategory.DB,
      action: Schemas.LogAction.WithTenant,
      message,
      metadata: {
        companyId: String(companyId).slice(0, LOGGED_ID_MAX_LENGTH),
        reason: describeInvalidCompanyId(companyId),
      },
    });
    return { isSuccess: false, message };
  }

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
      return await callback(tx);
    });
  } catch (error) {
    if (error instanceof TenantRollbackError) {
      return { isSuccess: false, message: error.message };
    }

    const message = "Unknown error in tenant transaction";
    AppLogger.error({
      category: Schemas.LogCategory.DB,
      action: Schemas.LogAction.WithTenant,
      message,
      error,
      metadata: { companyId },
    });
    return { isSuccess: false, message };
  }
}

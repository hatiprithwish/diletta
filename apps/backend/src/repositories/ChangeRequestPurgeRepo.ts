import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import ChangeRequestsDAL from "@/data-access-layer/ChangeRequestsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: The purge of change request values after their undo window (M3-7): encrypted_changes, iv and
// encryption_key_version go null once undo_until has passed (every company: withPlatform, pattern rule 3.15), so a
// change request keeps only its status, summary, counts and timeline. NeedsHuman ones have no undo_until and stay
// until a person resolves them; a Verified one whose user undo is under way is skipped (the DAL). One transaction per
// batch, so a long backlog never holds one; a run that stops early (a failed batch) leaves the rest to the next minute.
export default class ChangeRequestPurgeRepo {
  private db: NodePgDatabase;
  private dal: ChangeRequestsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChangeRequestsDAL();
  }

  async purgeExpiredValues(
    params: { now?: number } = {},
  ): Promise<Schemas.PurgeChangeRequestValuesResponse> {
    const before = new Date(params.now ?? Date.now());
    let purgedCount = 0;

    for (let batch = 0; batch < Constants.CHANGE_REQUEST_PURGE_MAX_BATCHES; batch += 1) {
      const purged = await withPlatform(this.db, async (tx) => {
        return await this.dal.purgeChangeRequestValues(tx, {
          before,
          limit: Constants.CHANGE_REQUEST_PURGE_BATCH_SIZE,
        });
      });
      const batchCount = "purgedCount" in purged ? (purged.purgedCount ?? 0) : 0;
      if (!purged.isSuccess) {
        return { isSuccess: false, message: purged.message, purgedCount };
      }
      purgedCount += batchCount;
      if (batchCount < Constants.CHANGE_REQUEST_PURGE_BATCH_SIZE) break;
    }

    return { isSuccess: true, message: "Change request values purged", purgedCount };
  }
}

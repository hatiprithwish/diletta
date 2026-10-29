import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import type * as Schemas from "@app/schemas";

const modelCallsDal = new ModelCallsDAL();

// DEV_NOTE: What a billing period has spent: SUM(model_calls.cost_usd) from the period start, every tier but Embed
// (embeddings are platform-paid). The one definition shared by BudgetDO's seed (BudgetRepo) and Settings › Budget's
// "used" (CompaniesRepo, M4-10), so the page and the enforcer count the same calls. Takes the Repo's tx; never opens a
// transaction and never throws (the DAL answers { isSuccess, message }).
export default class BudgetPeriodSpendProvider {
  static async getPeriodSpend(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; periodStart: Date },
  ): Promise<Schemas.ModelCallCostSumDALResponse> {
    return await modelCallsDal.getModelCallCostSum(tx, {
      companyId: params.companyId,
      from: params.periodStart,
    });
  }
}

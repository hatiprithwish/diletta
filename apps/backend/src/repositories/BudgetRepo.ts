import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ModelCallsDAL from "@/data-access-layer/ModelCallsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Budget (M2-4): what BudgetDO reads from Neon. The live counters are BudgetDO's own; Neon holds the budget
// an admin sets (companies.spending_budget, NULL = the platform default DEFAULT_SPENDING_BUDGET_USD) and, for the seed
// when a billing period starts, the spend model_calls already records for it. One withTenant per call: a company's
// budget is one company's data, even though BudgetDO serves no signed-in user.
export default class BudgetRepo {
  private db: NodePgDatabase;
  private companiesDal: CompaniesDAL;
  private modelCallsDal: ModelCallsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.companiesDal = new CompaniesDAL();
    this.modelCallsDal = new ModelCallsDAL();
  }

  async getBudgetSeed(params: Schemas.GetBudgetSeedRequest): Promise<Schemas.BudgetSeedResponse> {
    const result: Schemas.BudgetSeedResponse = await withTenant(
      this.db,
      params.companyId,
      async (tx) => {
        const company = await this.companiesDal.getCompanyDetails(tx, {
          companyId: params.companyId,
        });
        if (!company.isSuccess || !company.company) {
          return { isSuccess: false, message: company.message, isNotFound: company.isNotFound };
        }
        const spendingBudgetUsd =
          company.company.spendingBudget ?? Schemas.DEFAULT_SPENDING_BUDGET_USD;
        if (!params.isSpendNeeded) {
          return { isSuccess: true, message: "Budget fetched successfully", spendingBudgetUsd };
        }

        const spent = await this.modelCallsDal.getModelCallCostSum(tx, {
          companyId: params.companyId,
          from: params.periodStart,
        });
        if (!spent.isSuccess || spent.totalCostUsd === undefined) {
          return { isSuccess: false, message: spent.message };
        }
        return {
          isSuccess: true,
          message: "Budget fetched successfully",
          spendingBudgetUsd,
          spentUsd: spent.totalCostUsd,
        };
      },
    );

    if (!result.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.GetBudgetSeed,
        message: result.message ?? "Budget could not be read",
        metadata: { companyId: params.companyId, isSpendNeeded: params.isSpendNeeded },
      });
    }
    return result;
  }
}

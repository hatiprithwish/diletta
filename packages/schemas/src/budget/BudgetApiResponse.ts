import type { ApiResponse } from "../common";

// DEV_NOTE: Settings › Budget (M4-10). budgetUsd = the budget in force (the company's, else DEFAULT_SPENDING_BUDGET_USD,
// isDefault); usedUsd = what model_calls records for this billing period (live calls and test runs, every provider but
// embeddings: the sum BudgetDO is seeded from), both numeric(12,6) strings. The period is the UTC month.
export interface SpendingBudget {
  budgetUsd: string;
  isDefault: boolean;
  usedUsd: string;
  periodStart: string; // ISO time
  periodEnd: string; // ISO time, exclusive
}

export interface GetSpendingBudgetApiResponse extends ApiResponse {
  spendingBudget?: SpendingBudget;
}

export interface UpdateSpendingBudgetApiResponse extends ApiResponse {
  spendingBudget?: SpendingBudget;
}

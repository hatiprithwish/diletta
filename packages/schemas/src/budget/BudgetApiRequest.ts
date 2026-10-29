import { z } from "zod";
import { ZSpendingBudgetUsd } from "./BudgetCommon";

// DEV_NOTE: PUT /dashboard/settings/budget (Settings › Budget, M4-10): the company's spending budget per billing period
export const ZUpdateSpendingBudgetApiRequest = z.object({
  spendingBudgetUsd: ZSpendingBudgetUsd,
});
export type UpdateSpendingBudgetApiRequest = z.infer<typeof ZUpdateSpendingBudgetApiRequest>;

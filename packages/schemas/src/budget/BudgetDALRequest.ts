// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The spend already recorded for a company since `from` (the start of its billing period): BudgetDO's seed.
export type GetModelCallCostSumDALRequest = {
  companyId: string;
  from: Date;
};

// DEV_NOTE: Server-side only (EvalLoadRepo → the DALs): the company's rows created at or after `since`
export interface GetLoadWindowStatsDALRequest {
  companyId: string;
  since: Date;
}

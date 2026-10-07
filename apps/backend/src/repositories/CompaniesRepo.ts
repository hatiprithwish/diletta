import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant from "@/db/withTenant";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenancy-root Repo. Creating and listing companies are operator actions across companies, so they
// run in withPlatform; reading or editing one company runs in withTenant on that company (pattern rule 3.15).
// companyId is the internal companies.id, resolved server-side; never from the client.
export default class CompaniesRepo {
  private db: NodePgDatabase;
  private dal: CompaniesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new CompaniesDAL();
  }

  private withStatusLabel(company: Schemas.Company): Schemas.CompanyWithStatus {
    const { id: _id, updatedBy: _updatedBy, ...rest } = company;
    return {
      ...rest,
      companyStatus: company.status,
      companyStatusLabel: Schemas.COMPANY_STATUS_LABEL_MAP[company.status],
    };
  }

  private withCompanyResponse(result: Schemas.CompanyDALResponse): Schemas.GetCompanyApiResponse {
    const { company, ...rest } = result;
    return { ...rest, company: company ? this.withStatusLabel(company) : undefined };
  }

  async createCompany(
    params: Schemas.CreateCompanyApiRequest,
  ): Promise<Schemas.CreateCompanyApiResponse> {
    return await withPlatform(this.db, async (tx) => {
      const result = await this.dal.createCompany(tx, { name: params.company.name });
      return this.withCompanyResponse(result);
    });
  }

  async getCompanies(
    params: Schemas.GetCompaniesApiRequest,
  ): Promise<Schemas.GetCompaniesApiResponse> {
    return await withPlatform(this.db, async (tx) => {
      const { companies, ...rest } = await this.dal.getCompanies(tx, {
        pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
        pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
        sortColumn: params.sortColumn ?? Schemas.CompanySortColumn.CreatedAt,
        sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
      });
      return { ...rest, companies: companies?.map((company) => this.withStatusLabel(company)) };
    });
  }

  async getCompaniesCount(): Promise<Schemas.GetCompaniesCountApiResponse> {
    return await withPlatform(this.db, async (tx) => {
      return await this.dal.getCompaniesCount(tx);
    });
  }

  async getCompanyDetails(params: { companyId: string }): Promise<Schemas.GetCompanyApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.getCompanyDetails(tx, params);
      return this.withCompanyResponse(result);
    });
  }

  async updateCompany(
    params: Schemas.UpdateCompanyApiRequest & { companyId: string },
  ): Promise<Schemas.UpdateCompanyApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.updateCompany(tx, {
        companyId: params.companyId,
        name: params.company.name ?? null,
        status: null,
        isReadOnly: params.company.isReadOnly ?? null,
      });
      return this.withCompanyResponse(result);
    });
  }

  // DEV_NOTE: Operator only (pause, churn, reactivate). Still withTenant: it changes one known company (rule 3.15).
  async updateCompanyStatus(
    params: Schemas.UpdateCompanyStatusApiRequest & { companyId: string },
  ): Promise<Schemas.UpdateCompanyStatusApiResponse> {
    return await withTenant(this.db, params.companyId, async (tx) => {
      const result = await this.dal.updateCompany(tx, {
        companyId: params.companyId,
        name: null,
        status: params.company.status,
        isReadOnly: null,
      });
      return this.withCompanyResponse(result);
    });
  }
}

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CompanyKeyProvider from "@/providers/companyKey";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenancy-root Repo. Creating and listing companies are operator actions across companies, so they
// run in withPlatform; reading or editing one company runs in withTenant on that company (pattern rule 3.15).
// companyId is the internal companies.id, resolved server-side; never from the client.
export default class CompaniesRepo {
  private env: Env;
  private db: NodePgDatabase;
  private dal: CompaniesDAL;

  constructor(env: Env) {
    this.env = env;
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
      if (!result.isSuccess || !result.company) {
        return this.withCompanyResponse(result);
      }

      // DEV_NOTE: Transactional flow — a company never exists without its encryption key (version 1), so a failed
      // key rolls the company back too
      const companyKey = await CompanyKeyProvider.createCompanyKey(this.env, tx, {
        companyId: result.company.id,
        version: 1,
      });
      if (!companyKey.isSuccess) {
        throw new TenantRollbackError(companyKey.message);
      }

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

  // DEV_NOTE: An operator route on one company (/operator/companies/:companyPublicId/…) names it by public id. The
  // lookup crosses companies (no tenant context yet), so it runs in withPlatform; everything after it runs in
  // withTenant on the resolved id. Any status: an operator may curate a paused or churned company.
  async resolveCompanyId(params: { publicId: string }): Promise<Schemas.CompanyIdResponse> {
    return await withPlatform(this.db, async (tx): Promise<Schemas.CompanyIdResponse> => {
      const { company, ...rest } = await this.dal.getCompanyByPublicId(tx, params);
      return { ...rest, companyId: company?.id };
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

  private toRetention(company: Schemas.Company): Schemas.ContentRetention {
    return {
      contentRetentionDays: Schemas.effectiveContentRetentionDays(company.contentRetentionDays),
      isDefault: company.contentRetentionDays === null,
    };
  }

  // DEV_NOTE: The Security page's retention (M4-9): the days in force (the default until the company chooses)
  async getContentRetention(params: {
    companyId: string;
  }): Promise<Schemas.GetContentRetentionApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetContentRetentionApiResponse> => {
        const found = await this.dal.getCompanyDetails(tx, params);
        if (!found.isSuccess || !found.company) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        return {
          isSuccess: true,
          message: "Content retention fetched successfully",
          retention: this.toRetention(found.company),
        };
      },
    );
  }

  // DEV_NOTE: Save retention, with its audit row (M4-9) labelled with the days; the days already stored change nothing
  // and record nothing. The purge that deletes chat content past it is M6-1.
  async updateContentRetention(
    params: Schemas.UpdateContentRetentionApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateContentRetentionApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateContentRetentionApiResponse>> => {
        const found = await this.dal.getCompanyDetails(tx, { companyId: params.companyId });
        if (!found.isSuccess || !found.company) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.company.contentRetentionDays === params.contentRetentionDays) {
          return {
            isSuccess: true,
            message: "Content retention unchanged",
            retention: this.toRetention(found.company),
            outboxIds: [],
          };
        }

        const updated = await this.dal.updateCompanyContentRetention(tx, {
          companyId: params.companyId,
          contentRetentionDays: params.contentRetentionDays,
          updatedBy: params.adminId,
        });
        if (!updated.isSuccess || !updated.company) {
          return { isSuccess: false, message: updated.message, isNotFound: updated.isNotFound };
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.Company,
          entityAction: Schemas.AuditEntityActionEnum.RetentionChanged,
          entity: updated.company,
          label: `${params.contentRetentionDays} days`,
        });
        return {
          isSuccess: true,
          message: "Content retention updated successfully",
          retention: this.toRetention(updated.company),
          outboxIds: [outboxId],
        };
      },
    );
  }
}

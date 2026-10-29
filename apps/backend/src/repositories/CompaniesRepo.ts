import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import BudgetPeriodSpendProvider from "@/providers/budgetPeriodSpend";
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

  // DEV_NOTE: Save retention, with its audit row (M4-9) labelled with the days. Compared with the retention in force
  // (NULL = DEFAULT_CONTENT_RETENTION_DAYS), under the row lock: the days already in force, the default included, change
  // nothing and record nothing. The purge that deletes chat content past it is M6-1.
  async updateContentRetention(
    params: Schemas.UpdateContentRetentionApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateContentRetentionApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateContentRetentionApiResponse>> => {
        const found = await this.dal.getCompanyDetails(tx, {
          companyId: params.companyId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.company) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (
          Schemas.effectiveContentRetentionDays(found.company.contentRetentionDays) ===
          params.contentRetentionDays
        ) {
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

  // DEV_NOTE: The Bots page's Read-only mode (M4-10)
  async getReadOnlyMode(params: {
    companyId: string;
  }): Promise<Schemas.GetReadOnlyModeApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetReadOnlyModeApiResponse> => {
        const found = await this.dal.getCompanyDetails(tx, params);
        if (!found.isSuccess || !found.company) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        return {
          isSuccess: true,
          message: "Read-only mode fetched successfully",
          readOnlyMode: { isReadOnly: found.company.isReadOnly },
        };
      },
    );
  }

  // DEV_NOTE: Turn Read-only mode on or off, with its audit row (Turned on / Turned off), under the row lock; the value
  // already in force writes nothing and records nothing. The action engine reads is_read_only at every turn start (a
  // read-only company gets read tools only) and every change request step re-checks it, so it takes effect at once.
  async updateReadOnlyMode(
    params: Schemas.UpdateReadOnlyModeApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateReadOnlyModeApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateReadOnlyModeApiResponse>> => {
        const found = await this.dal.getCompanyDetails(tx, {
          companyId: params.companyId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.company) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.company.isReadOnly === params.isReadOnly) {
          return {
            isSuccess: true,
            message: "Read-only mode unchanged",
            readOnlyMode: { isReadOnly: found.company.isReadOnly },
            outboxIds: [],
          };
        }

        const updated = await this.dal.updateCompanyReadOnly(tx, {
          companyId: params.companyId,
          isReadOnly: params.isReadOnly,
          updatedBy: params.adminId,
        });
        if (!updated.isSuccess || !updated.company) {
          return { isSuccess: false, message: updated.message, isNotFound: updated.isNotFound };
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.Company,
          entityAction: params.isReadOnly
            ? Schemas.AuditEntityActionEnum.TurnedOn
            : Schemas.AuditEntityActionEnum.TurnedOff,
          entity: updated.company,
          label: "Read-only mode",
        });
        return {
          isSuccess: true,
          message: "Read-only mode updated successfully",
          readOnlyMode: { isReadOnly: updated.company.isReadOnly },
          outboxIds: [outboxId],
        };
      },
    );
  }

  // DEV_NOTE: Settings › Budget (M4-10): the budget in force and what this billing period has used so far, read from
  // model_calls in Neon through BudgetPeriodSpendProvider (the sum BudgetDO is seeded from). It can trail BudgetDO's live
  // count: Pending rows add 0 until backfilled, and holds in flight aren't rows yet.
  private async readSpendingBudget(
    tx: NodePgTransaction<EmptyRelations>,
    company: Schemas.Company,
  ): Promise<Schemas.GetSpendingBudgetApiResponse> {
    const periodKey = Schemas.budgetPeriodKey(Date.now());
    const periodStart = Schemas.budgetPeriodStart(periodKey);
    const used = await BudgetPeriodSpendProvider.getPeriodSpend(tx, {
      companyId: company.id,
      periodStart,
    });
    if (!used.isSuccess || used.totalCostUsd === undefined) {
      return { isSuccess: false, message: used.message };
    }
    return {
      isSuccess: true,
      message: "Spending budget fetched successfully",
      spendingBudget: {
        budgetUsd: company.spendingBudget ?? Schemas.DEFAULT_SPENDING_BUDGET_USD,
        isDefault: company.spendingBudget === null,
        usedUsd: used.totalCostUsd,
        periodStart: periodStart.toISOString(),
        periodEnd: Schemas.budgetPeriodEnd(periodKey).toISOString(),
      },
    };
  }

  async getSpendingBudget(params: {
    companyId: string;
  }): Promise<Schemas.GetSpendingBudgetApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetSpendingBudgetApiResponse> => {
        const found = await this.dal.getCompanyDetails(tx, params);
        if (!found.isSuccess || !found.company) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        return await this.readSpendingBudget(tx, found.company);
      },
    );
  }

  // DEV_NOTE: Save the spending budget, with its BudgetChanged audit row labelled with the amount. Compared in
  // micro-dollars with the budget in force (NULL = DEFAULT_SPENDING_BUDGET_USD), under the row lock: the amount already
  // in force, the default included, writes nothing and records nothing. BudgetDO picks it up within BUDGET_REFRESH_MS.
  async updateSpendingBudget(
    params: Schemas.UpdateSpendingBudgetApiRequest & { companyId: string; adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateSpendingBudgetApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateSpendingBudgetApiResponse>> => {
        const found = await this.dal.getCompanyDetails(tx, {
          companyId: params.companyId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.company) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const inForce = found.company.spendingBudget ?? Schemas.DEFAULT_SPENDING_BUDGET_USD;
        if (Schemas.usdToMicros(inForce) === Schemas.usdToMicros(params.spendingBudgetUsd)) {
          const unchanged = await this.readSpendingBudget(tx, found.company);
          if (!unchanged.isSuccess) return { ...unchanged, outboxIds: [] };
          return { ...unchanged, message: "Spending budget unchanged", outboxIds: [] };
        }

        const updated = await this.dal.updateCompanySpendingBudget(tx, {
          companyId: params.companyId,
          spendingBudget: params.spendingBudgetUsd.toFixed(6),
          updatedBy: params.adminId,
        });
        if (!updated.isSuccess || !updated.company) {
          return { isSuccess: false, message: updated.message, isNotFound: updated.isNotFound };
        }

        const outboxId = await recordAuditOrRollback(tx, {
          companyId: params.companyId,
          actor: adminAuditActor(params.adminId),
          entityType: Schemas.AuditEntityTypeEnum.Company,
          entityAction: Schemas.AuditEntityActionEnum.BudgetChanged,
          entity: updated.company,
          label: `$${params.spendingBudgetUsd.toFixed(2)}`,
        });
        // DEV_NOTE: Read back in the same transaction; if that read fails, the save and its audit row roll back
        // together, so an error answer never hides a saved change
        const result = await this.readSpendingBudget(tx, updated.company);
        if (!result.isSuccess) {
          throw new TenantRollbackError(result.message ?? "Spending budget not read back");
        }
        return {
          ...result,
          message: "Spending budget updated successfully",
          outboxIds: [outboxId],
        };
      },
    );
  }
}

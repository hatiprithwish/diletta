import { asc, count, desc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: The tenancy root — holds no db client. create and list run in withPlatform (operator, cross-company);
// get and update run in withTenant on the company's own row, so the id filter matches app.company_id.
export default class CompaniesDAL {
  async createCompany(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateCompanyDALRequest,
  ) {
    const response: Schemas.CompanyDALResponse = { isSuccess: false };

    try {
      const [companyResponse] = await tx
        .insert(companies)
        .values({
          publicId: Utility.generatePublicId(),
          name: params.name,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Company created successfully";
      response.company = companyResponse;
    } catch (error) {
      const message = "Unknown error in creating company";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateCompany,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getCompanyDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindCompanyDALRequest,
  ) {
    const response: Schemas.CompanyDALResponse = { isSuccess: false };

    try {
      const [company] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetCompanyDetails,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Company fetched successfully";
      response.company = company;
    } catch (error) {
      const message = "Unknown error in fetching company";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetCompanyDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getCompanies(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetCompaniesDALRequest,
  ) {
    const response: Schemas.CompaniesDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.CompanySortColumn.CreatedAt]: companies.createdAt,
        [Schemas.CompanySortColumn.Name]: companies.name,
        [Schemas.CompanySortColumn.Status]: companies.status,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;

      const companiesResponse = await tx
        .select()
        .from(companies)
        // DEV_NOTE: id breaks ties (same status or created_at), so rows never repeat or go missing between pages
        .orderBy(orderExpr, asc(companies.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Companies fetched successfully";
      response.companies = companiesResponse;
    } catch (error) {
      const message = "Unknown error in listing companies";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListCompanies,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getCompaniesCount(tx: NodePgTransaction<EmptyRelations>) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const [result] = await tx.select({ count: count() }).from(companies);

      response.isSuccess = true;
      response.message = "Companies counted successfully";
      response.totalRecords = result?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting companies";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountCompanies,
        message,
        error,
      });
      response.message = message;
    }

    return response;
  }

  async updateCompany(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateCompanyDALRequest,
  ) {
    const response: Schemas.CompanyDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const [companyResponse] = await tx
        .update(companies)
        .set({
          // DEV_NOTE: When a param is null, it's ignored
          name: params.name ?? undefined,
          status: params.status ?? undefined,
          isReadOnly: params.isReadOnly ?? undefined,
          updatedAt: now,
        })
        .where(eq(companies.id, params.companyId))
        .returning();

      if (!companyResponse) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.UpdateCompany,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Company updated successfully";
      response.company = companyResponse;
    } catch (error) {
      const message = "Unknown error in updating company";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateCompany,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}

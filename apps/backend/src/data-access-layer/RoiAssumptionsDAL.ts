import { asc, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { companies, roiAssumptions } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). Rows are append-only in practice (M4-3): a
// new value is a new row effective from its day, so earlier days keep the minutes they had.
export default class RoiAssumptionsDAL {
  async createRoiAssumption(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateRoiAssumptionDALRequest,
  ) {
    const response: Schemas.RoiAssumptionDALResponse = { isSuccess: false };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the reference before writing
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, params.companyId))
        .limit(1);

      if (!company) {
        const message = "Company not found";
        AppLogger.error({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateRoiAssumption,
          message,
          metadata: params,
        });
        response.message = message;
        return response;
      }

      const [roiAssumptionResponse] = await tx
        .insert(roiAssumptions)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          taskType: params.taskType,
          manualMinutes: params.manualMinutes,
          effectiveFrom: params.effectiveFrom,
          createdBy: params.createdBy,
        })
        .returning();

      response.isSuccess = true;
      response.message = "ROI assumption created successfully";
      response.roiAssumption = roiAssumptionResponse;
    } catch (error) {
      const message = "Unknown error in creating ROI assumption";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateRoiAssumption,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Oldest first (effective day, then creation): the Repo picks the row in force per day
  async getRoiAssumptions(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetRoiAssumptionsDALRequest,
  ) {
    const response: Schemas.RoiAssumptionsDALResponse = { isSuccess: false };

    try {
      const rows = await tx
        .select()
        .from(roiAssumptions)
        .where(eq(roiAssumptions.companyId, params.companyId))
        .orderBy(
          asc(roiAssumptions.effectiveFrom),
          asc(roiAssumptions.createdAt),
          asc(roiAssumptions.id),
        );

      response.isSuccess = true;
      response.message = "ROI assumptions fetched successfully";
      response.roiAssumptions = rows;
    } catch (error) {
      const message = "Unknown error in fetching ROI assumptions";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetRoiAssumptions,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}

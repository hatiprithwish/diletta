import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import RoiAssumptionsDAL from "@/data-access-layer/RoiAssumptionsDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo — Impact's minutes per task (M4-3). A save is a new row in force from today (UTC), never an
// edit, so the hours saved on earlier days keep the minutes they had. A tool task must name one of the company's write
// tools (getWriteToolSummaries), else 404; answers always exists.
export default class RoiAssumptionsRepo {
  private db: NodePgDatabase;
  private dal: RoiAssumptionsDAL;
  private toolDefinitionsDal: ToolDefinitionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new RoiAssumptionsDAL();
    this.toolDefinitionsDal = new ToolDefinitionsDAL();
  }

  private toView(roiAssumption: Schemas.RoiAssumption): Schemas.RoiAssumptionView {
    const { id: _id, companyId: _companyId, createdBy: _createdBy, ...rest } = roiAssumption;
    return rest;
  }

  async createRoiAssumption(
    params: Schemas.CreateRoiAssumptionApiRequest & {
      companyId: string;
      adminId: string;
      now?: number;
    },
  ): Promise<Schemas.CreateRoiAssumptionApiResponse> {
    const { companyId } = params;

    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.CreateRoiAssumptionApiResponse> => {
        const toolName = Schemas.roiTaskToolName(params.taskType);
        if (toolName !== null) {
          const tools = await this.toolDefinitionsDal.getWriteToolSummaries(tx, { companyId });
          if (!tools.isSuccess) return { isSuccess: false, message: tools.message };
          if (!(tools.tools ?? []).some((tool) => tool.name === toolName)) {
            return { isSuccess: false, isNotFound: true, message: "Tool not found" };
          }
        }

        const created = await this.dal.createRoiAssumption(tx, {
          companyId,
          taskType: params.taskType,
          manualMinutes: params.manualMinutes.toFixed(1),
          effectiveFrom: Schemas.activityRollupDayKey(params.now ?? Date.now()),
          createdBy: params.adminId,
        });
        const { roiAssumption, ...rest } = created;
        return { ...rest, roiAssumption: roiAssumption ? this.toView(roiAssumption) : undefined };
      },
    );
  }
}

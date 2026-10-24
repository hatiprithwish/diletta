import { and, eq } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { chatbots, evalCases } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). M4-6 creates customer cases from quality
// issues; platform cases (company_id null) are written by the eval harness's own seed (M5), never here.
export default class EvalCasesDAL {
  async createEvalCase(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateEvalCaseDALRequest,
  ) {
    const response: Schemas.EvalCaseDALResponse = { isSuccess: false };
    // DEV_NOTE: name, input and expectations are chat text (rewritten, but still text), so they stay out of the log
    const metadata = { companyId: params.companyId, chatbotId: params.chatbotId };

    try {
      // DEV_NOTE: No DB foreign keys — the DAL checks the chatbot exists in the company before writing
      const chatbotConditions = [
        eq(chatbots.id, params.chatbotId),
        eq(chatbots.companyId, params.companyId),
      ];
      const [chatbot] = await tx
        .select({ id: chatbots.id })
        .from(chatbots)
        .where(and(...chatbotConditions))
        .limit(1);

      if (!chatbot) {
        const message = "Chatbot not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.CreateEvalCase,
          message,
          metadata,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      const [evalCase] = await tx
        .insert(evalCases)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          name: params.name,
          input: params.input,
          expectations: params.expectations,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Eval case created successfully";
      response.evalCase = evalCase;
    } catch (error) {
      const message = "Unknown error in creating eval case";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateEvalCase,
        message,
        error,
        metadata,
      });
      response.message = message;
    }

    return response;
  }
}

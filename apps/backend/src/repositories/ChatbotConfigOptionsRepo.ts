import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tenant Repo for the Bots draft editor's pickers (M4-10), company-wide and read-only: the Active tool versions
// and the knowledge sources (each capped at CHATBOT_CONFIG_OPTIONS_MAX), and the providers with an Active model key
// (the provider column only). Kept apart from ChatbotConfigsRepo, which writes versions.
export default class ChatbotConfigOptionsRepo {
  private db: NodePgDatabase;
  private companySecretsDal: CompanySecretsDAL;
  private knowledgeSourcesDal: KnowledgeSourcesDAL;
  private toolDefinitionsDal: ToolDefinitionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.companySecretsDal = new CompanySecretsDAL();
    this.knowledgeSourcesDal = new KnowledgeSourcesDAL();
    this.toolDefinitionsDal = new ToolDefinitionsDAL();
  }

  async getChatbotConfigOptions(params: {
    companyId: string;
  }): Promise<Schemas.GetChatbotConfigOptionsApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetChatbotConfigOptionsApiResponse> => {
        const tools = await this.toolDefinitionsDal.getActiveToolDefinitionOptions(tx, {
          companyId: params.companyId,
          limit: Schemas.CHATBOT_CONFIG_OPTIONS_MAX,
        });
        if (!tools.isSuccess || !tools.options) return { isSuccess: false, message: tools.message };
        const sources = await this.knowledgeSourcesDal.getKnowledgeSourceOptions(tx, {
          companyId: params.companyId,
          limit: Schemas.CHATBOT_CONFIG_OPTIONS_MAX,
        });
        if (!sources.isSuccess || !sources.options) {
          return { isSuccess: false, message: sources.message };
        }
        const keys = await this.companySecretsDal.getActiveModelKeyProviders(tx, {
          companyId: params.companyId,
        });
        if (!keys.isSuccess || !keys.providers) return { isSuccess: false, message: keys.message };

        const activeKeyProviders = Object.values(Schemas.ModelProviderEnum).filter((provider) =>
          keys.providers?.includes(provider),
        );
        return {
          isSuccess: true,
          message: "Chatbot config options fetched successfully",
          options: {
            tools: tools.options.map((tool) => ({
              ...tool,
              riskLabel: Schemas.TOOL_DEFINITION_RISK_LABEL_MAP[tool.risk],
            })),
            knowledgeSources: sources.options,
            activeKeyProviders,
          },
        };
      },
    );
  }
}

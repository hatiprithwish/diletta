import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import getDbClient from "@/db/dbClient";
import withTenant from "@/db/withTenant";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The widget's bootstrap (M2-7, ADR 0002): what it shows before a conversation exists. The widget route
// calls it after WidgetAuthRepo.authenticate, so the identity is verified and the chatbot active. It reads only: no
// chatbot user, conversation or event is created, so a page view or an opened panel leaves no rows behind. The widget
// settings come from the published config through loadConfigSpec, like a turn's; a chatbot with no loadable
// published config answers widget: null (the widget shows it as unavailable, as a turn would).
export default class WidgetBootstrapRepo {
  private db: NodePgDatabase;
  private chatbotConfigsDal: ChatbotConfigsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.chatbotConfigsDal = new ChatbotConfigsDAL();
  }

  async getBootstrap(params: {
    identity: Schemas.WidgetIdentity;
  }): Promise<Schemas.WidgetBootstrapResponse> {
    const { identity } = params;
    const chatbot = { publicId: identity.chatbotPublicId, name: identity.chatbotName };

    const published: Schemas.ChatbotConfigDALResponse = await withTenant(
      this.db,
      identity.companyId,
      async (tx) => {
        return await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
          companyId: identity.companyId,
          chatbotId: identity.chatbotId,
        });
      },
    );
    if (!published.isSuccess || !published.chatbotConfig) {
      if (published.isNotFound) {
        return {
          isSuccess: true,
          message: "Chatbot has no published config",
          bootstrap: { chatbot, widget: null },
        };
      }
      return {
        isSuccess: false,
        message: published.message,
        failure: Schemas.WidgetAuthFailureEnum.ServerError,
      };
    }
    const { chatbotConfig } = published;

    const loaded = Schemas.loadConfigSpec({
      schemaVersion: chatbotConfig.schemaVersion,
      body: chatbotConfig.body,
    });
    if (!loaded.isSuccess || !loaded.spec) {
      AppLogger.error({
        category: Schemas.LogCategory.Widget,
        action: Schemas.LogAction.GetWidgetBootstrap,
        message: loaded.message ?? "Published config could not be loaded",
        metadata: {
          companyId: identity.companyId,
          chatbotId: identity.chatbotId,
          chatbotConfigId: chatbotConfig.id,
          schemaVersion: chatbotConfig.schemaVersion,
        },
      });
      return {
        isSuccess: true,
        message: "Published config could not be loaded",
        bootstrap: { chatbot, widget: null },
      };
    }

    const { widget } = loaded.spec;
    return {
      isSuccess: true,
      message: "Widget bootstrap loaded",
      bootstrap: {
        chatbot,
        widget: {
          greeting: widget.greeting,
          suggestions: widget.suggestions,
          launcherLabel: widget.launcherLabel ?? null,
        },
      },
    };
  }
}

import { and, asc, count, desc, eq, getColumns, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import { admins, chatbotConfigs, chatbots } from "@/db/tables";
import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";
import Utility from "@/utils/Utility";

// DEV_NOTE: Tenant DAL — holds no db client. Every method takes the tx opened by withTenant in the Repo,
// and every query filters on companyId (defence in depth on top of RLS). M2-2 reads the published config, M4-4 lists the ever
// published ones (a filter), M4-8 reads the newest draft, M4-10 (Settings › Bots) lists versions and writes drafts and
// publishes. body is returned raw: callers read it through loadConfigSpec (runtime) or readConfigBody (editor).
export default class ChatbotConfigsDAL {
  // DEV_NOTE: isNotFound when the chatbot has no published config (it can't answer yet)
  async getPublishedChatbotConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindPublishedChatbotConfigDALRequest,
  ) {
    const response: Schemas.ChatbotConfigDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
        eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Published),
      ];
      const [chatbotConfig] = await tx
        .select()
        .from(chatbotConfigs)
        .where(and(...conditions))
        .limit(1);

      if (!chatbotConfig) {
        const message = "Chatbot has no published config";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetPublishedChatbotConfig,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Published chatbot config fetched successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in fetching published chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetPublishedChatbotConfig,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The chatbot's newest config being worked on (Draft, Testing or Ready): the Tests page's Draft card (M4-8).
  // isNotFound when every config is published or archived.
  async getLatestDraftChatbotConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.FindLatestDraftChatbotConfigDALRequest,
  ) {
    const response: Schemas.ChatbotConfigDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
        inArray(chatbotConfigs.status, [
          Schemas.ChatbotConfigStatusIntEnum.Draft,
          Schemas.ChatbotConfigStatusIntEnum.Testing,
          Schemas.ChatbotConfigStatusIntEnum.Ready,
        ]),
      ];
      const [chatbotConfig] = await tx
        .select()
        .from(chatbotConfigs)
        .where(and(...conditions))
        .orderBy(desc(chatbotConfigs.configVersion))
        .limit(1);

      if (!chatbotConfig) {
        response.message = "Chatbot has no draft config";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Latest draft chatbot config fetched successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in fetching latest draft chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetLatestDraftChatbotConfig,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The Conversations page's Config filter (M4-4): every config of the company's chatbots that was ever
  // published, by chatbot name, newest version first. Inner join: a config whose chatbot is gone has no name to show.
  async getChatbotConfigOptions(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConfigOptionsDALRequest,
  ) {
    const response: Schemas.ChatbotConfigOptionsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.companyId, params.companyId),
        isNotNull(chatbotConfigs.publishedAt),
      ];
      const chatbotJoinConditions = [
        eq(chatbots.id, chatbotConfigs.chatbotId),
        eq(chatbots.companyId, chatbotConfigs.companyId),
      ];
      const options = await tx
        .select({
          id: chatbotConfigs.id,
          publicId: chatbotConfigs.publicId,
          chatbotId: chatbotConfigs.chatbotId,
          chatbotName: chatbots.name,
          configVersion: chatbotConfigs.configVersion,
        })
        .from(chatbotConfigs)
        .innerJoin(chatbots, and(...chatbotJoinConditions))
        .where(and(...conditions))
        .orderBy(asc(chatbots.name), desc(chatbotConfigs.configVersion), asc(chatbotConfigs.id));

      response.isSuccess = true;
      response.message = "Chatbot config options fetched successfully";
      response.options = options;
    } catch (error) {
      const message = "Unknown error in fetching chatbot config options";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotConfigOptions,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The admin shown as Edited by: the last to save the version, else who created it. Left join (a removed admin
  // or a system row has no name), matched on the company too.
  private versionSelection() {
    return { ...getColumns(chatbotConfigs), editedByName: admins.name };
  }

  private editorJoinConditions() {
    return [
      eq(admins.id, sql`coalesce(${chatbotConfigs.updatedBy}, ${chatbotConfigs.createdBy})`),
      eq(admins.companyId, chatbotConfigs.companyId),
    ];
  }

  async getChatbotConfigs(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConfigsDALRequest,
  ) {
    const response: Schemas.ChatbotConfigVersionsDALResponse = { isSuccess: false };

    try {
      const sortColumnMap = {
        [Schemas.ChatbotConfigSortColumn.ConfigVersion]: chatbotConfigs.configVersion,
      };
      const sortCol = sortColumnMap[params.sortColumn];
      const orderExpr =
        params.sortDirection === Schemas.SortDirection.Desc ? desc(sortCol) : asc(sortCol);
      const offset = (params.pageNo - 1) * params.pageSize;
      const conditions = [
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
      ];

      const chatbotConfigsResponse = await tx
        .select(this.versionSelection())
        .from(chatbotConfigs)
        .leftJoin(admins, and(...this.editorJoinConditions()))
        .where(and(...conditions))
        .orderBy(orderExpr, asc(chatbotConfigs.id))
        .limit(params.pageSize)
        .offset(offset);

      response.isSuccess = true;
      response.message = "Chatbot configs fetched successfully";
      response.chatbotConfigs = chatbotConfigsResponse;
    } catch (error) {
      const message = "Unknown error in listing chatbot configs";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ListChatbotConfigs,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbotConfigsCount(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConfigsCountDALRequest,
  ) {
    const response: Schemas.TotalRecordsResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
      ];
      const [result] = await tx
        .select({ count: count() })
        .from(chatbotConfigs)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Chatbot configs counted successfully";
      response.totalRecords = result?.count ?? 0;
    } catch (error) {
      const message = "Unknown error in counting chatbot configs";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CountChatbotConfigs,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The lock (isForUpdate) takes the config row only, not the joined admin
  async getChatbotConfigDetails(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConfigDetailsDALRequest,
  ) {
    const response: Schemas.ChatbotConfigVersionDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.publicId, params.publicId),
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
      ];
      const query = tx
        .select(this.versionSelection())
        .from(chatbotConfigs)
        .leftJoin(admins, and(...this.editorJoinConditions()))
        .where(and(...conditions))
        .limit(1);
      const [chatbotConfig] = params.isForUpdate
        ? await query.for("update", { of: chatbotConfigs })
        : await query;

      if (!chatbotConfig) {
        const message = "Chatbot config not found";
        AppLogger.warn({
          category: Schemas.LogCategory.DAL,
          action: Schemas.LogAction.GetChatbotConfigDetails,
          message,
          metadata: params,
        });
        response.message = message;
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot config fetched successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in fetching chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotConfigDetails,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbotConfigVersionState(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConfigVersionStateDALRequest,
  ) {
    const response: Schemas.ChatbotConfigVersionStateDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
      ];
      const [result] = await tx
        .select({
          latestVersion: max(chatbotConfigs.configVersion),
          openCount: sql<number>`count(*) filter (where ${inArray(chatbotConfigs.status, [
            ...Schemas.CHATBOT_CONFIG_OPEN_STATUSES,
          ])})`.mapWith(Number),
        })
        .from(chatbotConfigs)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Chatbot config version state fetched successfully";
      response.latestVersion = result?.latestVersion ?? 0;
      response.hasOpenVersion = (result?.openCount ?? 0) > 0;
    } catch (error) {
      const message = "Unknown error in fetching chatbot config version state";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotConfigVersionState,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: No DB foreign keys: the chatbot is checked by the Repo, which holds its row lock
  async createChatbotConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.CreateChatbotConfigDALRequest,
  ) {
    const response: Schemas.ChatbotConfigDALResponse = { isSuccess: false };

    try {
      const [chatbotConfig] = await tx
        .insert(chatbotConfigs)
        .values({
          publicId: Utility.generatePublicId(),
          companyId: params.companyId,
          chatbotId: params.chatbotId,
          configVersion: params.configVersion,
          schemaVersion: params.schemaVersion,
          status: Schemas.ChatbotConfigStatusIntEnum.Draft,
          body: params.body,
          bodyHash: params.bodyHash,
          createdBy: params.createdBy,
          updatedBy: params.createdBy,
        })
        .returning();

      response.isSuccess = true;
      response.message = "Chatbot config created successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in creating chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.CreateChatbotConfig,
        message,
        error,
        metadata: { ...params, body: undefined },
      });
      response.message = message;
    }

    return response;
  }

  async updateChatbotConfigDraft(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.UpdateChatbotConfigDraftDALRequest,
  ) {
    const response: Schemas.ChatbotConfigDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.publicId, params.publicId),
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
        eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Draft),
      ];
      const [chatbotConfig] = await tx
        .update(chatbotConfigs)
        .set({
          schemaVersion: params.schemaVersion,
          body: params.body,
          bodyHash: params.bodyHash,
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!chatbotConfig) {
        response.message = "Draft chatbot config not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Draft chatbot config saved successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in saving draft chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.UpdateChatbotConfigDraft,
        message,
        error,
        metadata: { ...params, body: undefined },
      });
      response.message = message;
    }

    return response;
  }

  async archiveChatbotConfigDraft(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ArchiveChatbotConfigDraftDALRequest,
  ) {
    const response: Schemas.ChatbotConfigDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.publicId, params.publicId),
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
        eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Draft),
      ];
      const [chatbotConfig] = await tx
        .update(chatbotConfigs)
        .set({
          status: Schemas.ChatbotConfigStatusIntEnum.Archived,
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning();

      if (!chatbotConfig) {
        response.message = "Draft chatbot config not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Draft chatbot config discarded successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in discarding draft chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ArchiveChatbotConfigDraft,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async archivePublishedChatbotConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.ArchivePublishedChatbotConfigDALRequest,
  ) {
    const response: Schemas.ApiResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
        eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Published),
      ];
      await tx
        .update(chatbotConfigs)
        .set({
          status: Schemas.ChatbotConfigStatusIntEnum.Archived,
          updatedBy: params.updatedBy,
          updatedAt: new Date(),
        })
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Published chatbot config archived successfully";
    } catch (error) {
      const message = "Unknown error in archiving published chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.ArchivePublishedChatbotConfig,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Draft → Published (the DAL matches Draft). The caller archives the old Published version first, in the
  // same transaction (UNQ_chatbot_configs_chatbot_id_published).
  async publishChatbotConfig(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.PublishChatbotConfigDALRequest,
  ) {
    const response: Schemas.ChatbotConfigDALResponse = { isSuccess: false };

    try {
      const now = new Date();
      const conditions = [
        eq(chatbotConfigs.publicId, params.publicId),
        eq(chatbotConfigs.chatbotId, params.chatbotId),
        eq(chatbotConfigs.companyId, params.companyId),
        eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Draft),
      ];
      const [chatbotConfig] = await tx
        .update(chatbotConfigs)
        .set({
          status: Schemas.ChatbotConfigStatusIntEnum.Published,
          publishedBy: params.publishedBy,
          publishedAt: now,
          updatedBy: params.publishedBy,
          updatedAt: now,
        })
        .where(and(...conditions))
        .returning();

      if (!chatbotConfig) {
        response.message = "Draft chatbot config not found";
        response.isNotFound = true;
        return response;
      }

      response.isSuccess = true;
      response.message = "Chatbot config published successfully";
      response.chatbotConfig = chatbotConfig;
    } catch (error) {
      const message = "Unknown error in publishing chatbot config";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.PublishChatbotConfig,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: The company's Published configs, as stored (the pin guard reads them through Schemas.readConfigBody)
  async getPublishedChatbotConfigBodies(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetPublishedChatbotConfigBodiesDALRequest,
  ) {
    const response: Schemas.PublishedChatbotConfigBodiesDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.companyId, params.companyId),
        eq(chatbotConfigs.status, Schemas.ChatbotConfigStatusIntEnum.Published),
      ];
      response.configs = await tx
        .select({
          publicId: chatbotConfigs.publicId,
          schemaVersion: chatbotConfigs.schemaVersion,
          body: chatbotConfigs.body,
        })
        .from(chatbotConfigs)
        .where(and(...conditions));
      response.isSuccess = true;
      response.message = "Published chatbot configs fetched successfully";
    } catch (error) {
      const message = "Unknown error in fetching published chatbot configs";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetPublishedChatbotConfigBodies,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }

  async getChatbotConfigHeads(
    tx: NodePgTransaction<EmptyRelations>,
    params: Schemas.GetChatbotConfigHeadsDALRequest,
  ) {
    const response: Schemas.ChatbotConfigHeadsDALResponse = { isSuccess: false };

    try {
      const conditions = [
        eq(chatbotConfigs.companyId, params.companyId),
        inArray(chatbotConfigs.status, [
          Schemas.ChatbotConfigStatusIntEnum.Published,
          ...Schemas.CHATBOT_CONFIG_OPEN_STATUSES,
        ]),
      ];
      const heads = await tx
        .select({
          chatbotId: chatbotConfigs.chatbotId,
          publicId: chatbotConfigs.publicId,
          configVersion: chatbotConfigs.configVersion,
          status: chatbotConfigs.status,
        })
        .from(chatbotConfigs)
        .where(and(...conditions));

      response.isSuccess = true;
      response.message = "Chatbot config heads fetched successfully";
      response.heads = heads;
    } catch (error) {
      const message = "Unknown error in fetching chatbot config heads";
      AppLogger.error({
        category: Schemas.LogCategory.DAL,
        action: Schemas.LogAction.GetChatbotConfigHeads,
        message,
        error,
        metadata: params,
      });
      response.message = message;
    }

    return response;
  }
}

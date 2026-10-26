import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import EvalRunsDAL from "@/data-access-layer/EvalRunsDAL";
import KnowledgeSourcesDAL from "@/data-access-layer/KnowledgeSourcesDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import Constants from "@/config/Constants";
import { adminAuditActor, recordAuditOrRollback } from "@/repositories/audit";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

type ChatbotScope = { companyId: string; chatbotPublicId: string };
type ConfigScope = ChatbotScope & { publicId: string };

type ResolvedChatbot =
  | { isSuccess: true; chatbot: Schemas.Chatbot }
  | { isSuccess: false; response: Schemas.ApiResponse };

type NormalizedBody =
  | { isSuccess: true; schemaVersion: number; body: Schemas.ConfigSpecBody; bodyHash: string }
  | { isSuccess: false; response: Schemas.ChatbotConfigWriteApiResponse };

// DEV_NOTE: Tenant Repo for Settings › Bots (M4-10): a chatbot's versions, its one draft and the publish. companyId is
// the internal companies.id, resolved server-side; chatbots and versions are addressed by publicId, and every version is
// read within its chatbot. Lifecycle: a draft (Draft) is created new or as a copy of any version (rollback = copy), saved
// in place, discarded (→ Archived: configs are never deleted, runs and conversations point at them) or published
// (→ Published, the previous Published → Archived). One open version (Draft, Testing, Ready) per chatbot, held by the
// chatbot row's lock. Bodies are written only through normalizeConfigBody and read for the editor through
// readConfigBody (no platform defaults). Every write records its audit row in its own transaction.
export default class ChatbotConfigsRepo {
  private db: NodePgDatabase;
  private dal: ChatbotConfigsDAL;
  private chatbotsDal: ChatbotsDAL;
  private companySecretsDal: CompanySecretsDAL;
  private evalRunsDal: EvalRunsDAL;
  private knowledgeSourcesDal: KnowledgeSourcesDAL;
  private toolDefinitionsDal: ToolDefinitionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChatbotConfigsDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.companySecretsDal = new CompanySecretsDAL();
    this.evalRunsDal = new EvalRunsDAL();
    this.knowledgeSourcesDal = new KnowledgeSourcesDAL();
    this.toolDefinitionsDal = new ToolDefinitionsDAL();
  }

  private refuse(
    failure: Schemas.ChatbotConfigFailureEnum,
    message: string,
    detail: Omit<Schemas.ChatbotConfigWriteApiResponse, "isSuccess" | "message" | "failure"> = {},
  ): Schemas.ChatbotConfigWriteApiResponse {
    return { isSuccess: false, message, failure, ...detail };
  }

  private toVersion(
    row: Schemas.ChatbotConfigVersionRow,
    run: Pick<Schemas.EvalRun, "status" | "hasPassed"> | null,
  ): Schemas.ChatbotConfigVersion {
    return {
      publicId: row.publicId,
      configVersion: row.configVersion,
      schemaVersion: row.schemaVersion,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      chatbotConfigStatus: row.status,
      chatbotConfigStatusLabel: Schemas.CHATBOT_CONFIG_STATUS_LABEL_MAP[row.status],
      editedByName: row.editedByName,
      testResult: Schemas.chatbotConfigTestResult(run),
    };
  }

  // DEV_NOTE: The chatbot by public id within the company; isForUpdate serialises every draft write and publish of it
  private async resolveChatbot(
    tx: Tx,
    params: ChatbotScope & { isForUpdate?: boolean },
  ): Promise<ResolvedChatbot> {
    const found = await this.chatbotsDal.getChatbotDetails(tx, {
      companyId: params.companyId,
      publicId: params.chatbotPublicId,
      isForUpdate: params.isForUpdate,
    });
    if (!found.isSuccess || !found.chatbot) {
      return {
        isSuccess: false,
        response: { isSuccess: false, message: found.message, isNotFound: found.isNotFound },
      };
    }
    return { isSuccess: true, chatbot: found.chatbot };
  }

  private async normalize(body: unknown): Promise<NormalizedBody> {
    const normalized = Schemas.normalizeConfigBody(body);
    if (!normalized.isSuccess || !normalized.body || normalized.schemaVersion === undefined) {
      return {
        isSuccess: false,
        response: this.refuse(
          Schemas.ChatbotConfigFailureEnum.InvalidBody,
          normalized.message ?? "Invalid config body",
        ),
      };
    }
    return {
      isSuccess: true,
      schemaVersion: normalized.schemaVersion,
      body: normalized.body,
      bodyHash: await Utility.sha256Hex(Utility.stableStringify(normalized.body)),
    };
  }

  // DEV_NOTE: One version as the editor reads it, with its tests and the body the company stored (upgraded, no defaults)
  private async readDetail(
    tx: Tx,
    params: { companyId: string; chatbot: Schemas.Chatbot; publicId: string },
  ): Promise<Schemas.GetChatbotConfigApiResponse> {
    const found = await this.dal.getChatbotConfigDetails(tx, {
      companyId: params.companyId,
      chatbotId: params.chatbot.id,
      publicId: params.publicId,
    });
    if (!found.isSuccess || !found.chatbotConfig) {
      return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
    }
    const row = found.chatbotConfig;
    const runs = await this.evalRunsDal.getLatestEvalRunsByConfig(tx, {
      companyId: params.companyId,
      chatbotConfigIds: [row.id],
    });
    if (!runs.isSuccess || !runs.runs) return { isSuccess: false, message: runs.message };

    const read = Schemas.readConfigBody({ schemaVersion: row.schemaVersion, body: row.body });
    return {
      isSuccess: true,
      message: "Chatbot config fetched successfully",
      chatbotConfig: {
        ...this.toVersion(row, runs.runs[0] ?? null),
        chatbotPublicId: params.chatbot.publicId,
        body: read.isSuccess && read.body ? read.body : null,
        bodyIssue: read.isSuccess ? null : (read.message ?? "The stored config doesn't read"),
      },
    };
  }

  private async audit(
    tx: Tx,
    params: { companyId: string; adminId: string },
    chatbot: Schemas.Chatbot,
    chatbotConfig: Schemas.ChatbotConfig,
    entityAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.ChatbotConfig>,
  ): Promise<string> {
    return await recordAuditOrRollback(tx, {
      companyId: params.companyId,
      actor: adminAuditActor(params.adminId),
      entityType: Schemas.AuditEntityTypeEnum.ChatbotConfig,
      entityAction,
      entity: chatbotConfig,
      entityVersion: chatbotConfig.configVersion,
      label: Schemas.chatbotConfigLabel(chatbot.name, chatbotConfig.configVersion),
    });
  }

  // DEV_NOTE: A written version's answer, read back in the same transaction with its audit row's outbox id. A failed read
  // rolls the write back (TenantRollbackError), so a 500 never hides a write that committed.
  private async answerWrite(
    tx: Tx,
    params: { companyId: string; adminId: string },
    chatbot: Schemas.Chatbot,
    written: Schemas.ChatbotConfigDALResponse,
    entityAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.ChatbotConfig>,
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    if (!written.isSuccess || !written.chatbotConfig) {
      return { isSuccess: false, message: written.message, isNotFound: written.isNotFound };
    }
    const outboxId = await this.audit(tx, params, chatbot, written.chatbotConfig, entityAction);
    const detail = await this.readDetail(tx, {
      companyId: params.companyId,
      chatbot,
      publicId: written.chatbotConfig.publicId,
    });
    if (!detail.isSuccess)
      throw new TenantRollbackError(detail.message ?? "Chatbot config not read");
    return { ...detail, outboxIds: [outboxId] };
  }

  async getChatbotConfigs(
    params: Schemas.GetChatbotConfigsApiRequest & ChatbotScope,
  ): Promise<Schemas.GetChatbotConfigsApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetChatbotConfigsApiResponse> => {
        const resolved = await this.resolveChatbot(tx, params);
        if (!resolved.isSuccess) return resolved.response;

        const listed = await this.dal.getChatbotConfigs(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Schemas.CHATBOT_CONFIG_VERSIONS_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.ChatbotConfigSortColumn.ConfigVersion,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!listed.isSuccess || !listed.chatbotConfigs) {
          return { isSuccess: false, message: listed.message };
        }
        const runs = await this.evalRunsDal.getLatestEvalRunsByConfig(tx, {
          companyId: params.companyId,
          chatbotConfigIds: listed.chatbotConfigs.map((row) => row.id),
        });
        if (!runs.isSuccess || !runs.runs) return { isSuccess: false, message: runs.message };

        const runByConfig = new Map(runs.runs.map((run) => [run.chatbotConfigId, run]));
        return {
          isSuccess: true,
          message: listed.message,
          chatbotConfigs: listed.chatbotConfigs.map((row) =>
            this.toVersion(row, runByConfig.get(row.id) ?? null),
          ),
        };
      },
    );
  }

  async getChatbotConfigsCount(
    params: ChatbotScope,
  ): Promise<Schemas.GetChatbotConfigsCountApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetChatbotConfigsCountApiResponse> => {
        const resolved = await this.resolveChatbot(tx, params);
        if (!resolved.isSuccess) return resolved.response;
        return await this.dal.getChatbotConfigsCount(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
        });
      },
    );
  }

  async getChatbotConfigDetails(params: ConfigScope): Promise<Schemas.GetChatbotConfigApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetChatbotConfigApiResponse> => {
        const resolved = await this.resolveChatbot(tx, params);
        if (!resolved.isSuccess) return resolved.response;
        return await this.readDetail(tx, {
          companyId: params.companyId,
          chatbot: resolved.chatbot,
          publicId: params.publicId,
        });
      },
    );
  }

  // DEV_NOTE: The editor's pickers: the company's Active tool versions and its knowledge sources (capped at
  // CHATBOT_CONFIG_OPTIONS_MAX), and the providers with an Active model key
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
        const secrets = await this.companySecretsDal.getCompanySecrets(tx, {
          companyId: params.companyId,
        });
        if (!secrets.isSuccess || !secrets.companySecrets) {
          return { isSuccess: false, message: secrets.message };
        }

        const providers = Object.values(Schemas.ModelProviderEnum);
        const activeKeyProviders = providers.filter((provider) =>
          secrets.companySecrets?.some(
            (secret) =>
              secret.type === Schemas.CompanySecretTypeIntEnum.ModelKey &&
              secret.status === Schemas.CompanySecretStatusIntEnum.Active &&
              secret.provider === provider,
          ),
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

  // DEV_NOTE: The next version number and the one-draft rule, read under the chatbot row's lock
  private async nextDraftVersion(
    tx: Tx,
    params: { companyId: string; chatbotId: string },
  ): Promise<
    | { isSuccess: true; version: number }
    | { isSuccess: false; response: Schemas.ChatbotConfigWriteApiResponse }
  > {
    const state = await this.dal.getChatbotConfigVersionState(tx, params);
    if (!state.isSuccess || state.latestVersion === undefined) {
      return { isSuccess: false, response: { isSuccess: false, message: state.message } };
    }
    if (state.hasOpenVersion) {
      return {
        isSuccess: false,
        response: this.refuse(
          Schemas.ChatbotConfigFailureEnum.DraftExists,
          "This chatbot already has a draft; open it, or discard it first",
        ),
      };
    }
    return { isSuccess: true, version: state.latestVersion + 1 };
  }

  // DEV_NOTE: A new draft from the editor's body (a chatbot's first version, or one started blank)
  async createChatbotConfig(
    params: Schemas.SaveChatbotConfigApiRequest & ChatbotScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    const normalized = await this.normalize(params.body);
    if (!normalized.isSuccess) return normalized.response;

    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, { ...params, isForUpdate: true });
        if (!resolved.isSuccess) return resolved.response;
        const next = await this.nextDraftVersion(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
        });
        if (!next.isSuccess) return next.response;

        const created = await this.dal.createChatbotConfig(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          configVersion: next.version,
          schemaVersion: normalized.schemaVersion,
          body: normalized.body,
          bodyHash: normalized.bodyHash,
          createdBy: params.adminId,
        });
        return await this.answerWrite(
          tx,
          params,
          resolved.chatbot,
          created,
          Schemas.AuditEntityActionEnum.Created,
        );
      },
    );
  }

  // DEV_NOTE: Rollback as copy (and Open draft from the live version): any version's body, upgraded to the current schema
  // version, becomes a new draft at the next version number. The copied version itself never changes.
  async copyChatbotConfig(
    params: ConfigScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, { ...params, isForUpdate: true });
        if (!resolved.isSuccess) return resolved.response;
        const source = await this.dal.getChatbotConfigDetails(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          publicId: params.publicId,
        });
        if (!source.isSuccess || !source.chatbotConfig) {
          return { isSuccess: false, message: source.message, isNotFound: source.isNotFound };
        }
        const read = Schemas.readConfigBody({
          schemaVersion: source.chatbotConfig.schemaVersion,
          body: source.chatbotConfig.body,
        });
        if (!read.isSuccess || !read.body) {
          return { isSuccess: false, message: read.message ?? "The stored config doesn't read" };
        }
        const normalized = await this.normalize(read.body);
        if (!normalized.isSuccess) return normalized.response;
        const next = await this.nextDraftVersion(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
        });
        if (!next.isSuccess) return next.response;

        const created = await this.dal.createChatbotConfig(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          configVersion: next.version,
          schemaVersion: normalized.schemaVersion,
          body: normalized.body,
          bodyHash: normalized.bodyHash,
          createdBy: params.adminId,
        });
        return await this.answerWrite(
          tx,
          params,
          resolved.chatbot,
          created,
          Schemas.AuditEntityActionEnum.Created,
        );
      },
    );
  }

  // DEV_NOTE: The version locked and checked Draft first, so a save never lands on a version that left Draft. A body
  // whose hash is unchanged writes nothing and records nothing.
  async saveChatbotConfigDraft(
    params: Schemas.SaveChatbotConfigApiRequest & ConfigScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    const normalized = await this.normalize(params.body);
    if (!normalized.isSuccess) return normalized.response;

    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, params);
        if (!resolved.isSuccess) return resolved.response;
        const found = await this.dal.getChatbotConfigDetails(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.chatbotConfig) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.chatbotConfig.status !== Schemas.ChatbotConfigStatusIntEnum.Draft) {
          return this.refuse(
            Schemas.ChatbotConfigFailureEnum.NotDraft,
            "Only a draft can be edited; copy this version into a new draft",
          );
        }
        if (
          found.chatbotConfig.bodyHash === normalized.bodyHash &&
          found.chatbotConfig.schemaVersion === normalized.schemaVersion
        ) {
          const detail = await this.readDetail(tx, {
            companyId: params.companyId,
            chatbot: resolved.chatbot,
            publicId: params.publicId,
          });
          return { ...detail, outboxIds: [] };
        }

        const saved = await this.dal.updateChatbotConfigDraft(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          publicId: params.publicId,
          schemaVersion: normalized.schemaVersion,
          body: normalized.body,
          bodyHash: normalized.bodyHash,
          updatedBy: params.adminId,
        });
        return await this.answerWrite(
          tx,
          params,
          resolved.chatbot,
          saved,
          Schemas.AuditEntityActionEnum.Updated,
        );
      },
    );
  }

  async discardChatbotConfigDraft(
    params: ConfigScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, params);
        if (!resolved.isSuccess) return resolved.response;
        const found = await this.dal.getChatbotConfigDetails(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.chatbotConfig) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.chatbotConfig.status !== Schemas.ChatbotConfigStatusIntEnum.Draft) {
          return this.refuse(
            Schemas.ChatbotConfigFailureEnum.NotDraft,
            "Only a draft can be discarded",
          );
        }

        const archived = await this.dal.archiveChatbotConfigDraft(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          publicId: params.publicId,
          updatedBy: params.adminId,
        });
        return await this.answerWrite(
          tx,
          params,
          resolved.chatbot,
          archived,
          Schemas.AuditEntityActionEnum.Discarded,
        );
      },
    );
  }

  // DEV_NOTE: What a publish needs, checked in the database under the publish's locks: an Active model key for every
  // provider the routing uses (the M4-10 "Done when"), a price for every model, and every pin Active (read FOR SHARE, so
  // a Disable can't commit in between). Null = all there.
  private async checkPublishNeeds(
    tx: Tx,
    params: { companyId: string; body: Schemas.ConfigSpecBody },
  ): Promise<Schemas.ChatbotConfigWriteApiResponse | null> {
    const needs = Schemas.getChatbotConfigPublishNeeds(params.body);

    const missingKeyProviders: Schemas.ModelProviderEnum[] = [];
    for (const provider of needs.providers) {
      const key = await this.companySecretsDal.getActiveModelKey(tx, {
        companyId: params.companyId,
        provider,
      });
      if (key.isNotFound) {
        missingKeyProviders.push(provider);
      } else if (!key.isSuccess) {
        return { isSuccess: false, message: key.message };
      }
    }
    if (missingKeyProviders.length > 0) {
      const names = missingKeyProviders.map(
        (provider) => Schemas.MODEL_PROVIDER_LABEL_MAP[provider],
      );
      return this.refuse(
        Schemas.ChatbotConfigFailureEnum.ModelKeyMissing,
        `Add a working model key for ${names.join(" and ")} before publishing`,
        { missingKeyProviders },
      );
    }

    if (needs.unpricedModels.length > 0) {
      return this.refuse(
        Schemas.ChatbotConfigFailureEnum.ModelNotPriced,
        `Choose a supported model instead of ${needs.unpricedModels.join(", ")}`,
        { unpricedModels: needs.unpricedModels },
      );
    }

    const pinned = await this.toolDefinitionsDal.getPinnedToolDefinitions(tx, {
      companyId: params.companyId,
      pins: needs.pins,
      isForShare: true,
    });
    if (!pinned.isSuccess || !pinned.toolDefinitions) {
      return { isSuccess: false, message: pinned.message };
    }
    const activePins = new Set(
      pinned.toolDefinitions
        .filter((tool) => tool.status === Schemas.ToolDefinitionStatusIntEnum.Active)
        .map((tool) => `${tool.name}@${tool.version}`),
    );
    const inactiveTools = needs.pins.filter((pin) => !activePins.has(`${pin.name}@${pin.version}`));
    if (inactiveTools.length > 0) {
      const names = inactiveTools.map((pin) => `${pin.name} v${pin.version}`);
      return this.refuse(
        Schemas.ChatbotConfigFailureEnum.ToolNotActive,
        `These tools aren't turned on: ${names.join(", ")}. Remove them or pick an active version`,
        { inactiveTools },
      );
    }
    return null;
  }

  // DEV_NOTE: Draft → Published in one transaction: the chatbot row locked (publishes of one chatbot run one at a time),
  // the version locked and checked Draft, its needs checked, the old Published version archived, this one published, and
  // its audit row. The runtime reads the Published config at every turn, so the next message uses it. The eval gate
  // (Ready + approved_by_run_id, safety hard gate) is M5-4.
  async publishChatbotConfig(
    params: ConfigScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, { ...params, isForUpdate: true });
        if (!resolved.isSuccess) return resolved.response;
        const found = await this.dal.getChatbotConfigDetails(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.chatbotConfig) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        if (found.chatbotConfig.status !== Schemas.ChatbotConfigStatusIntEnum.Draft) {
          return this.refuse(
            Schemas.ChatbotConfigFailureEnum.NotDraft,
            "Only a draft can be published",
          );
        }
        const read = Schemas.readConfigBody({
          schemaVersion: found.chatbotConfig.schemaVersion,
          body: found.chatbotConfig.body,
        });
        if (!read.isSuccess || !read.body) {
          return this.refuse(
            Schemas.ChatbotConfigFailureEnum.InvalidBody,
            read.message ?? "The stored config doesn't read",
          );
        }
        const refused = await this.checkPublishNeeds(tx, {
          companyId: params.companyId,
          body: read.body,
        });
        if (refused) return refused;

        const archived = await this.dal.archivePublishedChatbotConfig(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          updatedBy: params.adminId,
        });
        if (!archived.isSuccess) return { isSuccess: false, message: archived.message };
        const published = await this.dal.publishChatbotConfig(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          publicId: params.publicId,
          publishedBy: params.adminId,
        });
        // DEV_NOTE: The old version is already archived: a failed publish must not commit a chatbot with none
        if (!published.isSuccess) {
          throw new TenantRollbackError(published.message ?? "Chatbot config not published");
        }
        return await this.answerWrite(
          tx,
          params,
          resolved.chatbot,
          published,
          Schemas.AuditEntityActionEnum.Published,
        );
      },
    );
  }
}

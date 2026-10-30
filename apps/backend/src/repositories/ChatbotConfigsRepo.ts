import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import EvalCasesDAL from "@/data-access-layer/EvalCasesDAL";
import EvalRunsDAL from "@/data-access-layer/EvalRunsDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import Constants from "@/config/Constants";
import EvalRunsProvider from "@/providers/evalRuns";
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
// in place, discarded (→ Archived: configs are never deleted, runs and conversations point at them) or sent to testing
// (→ Testing, M5-4). Its gate run's finish (EvalHarnessRepo) moves it to Ready (approved_by_run_id) or back to Draft; an
// admin can take a Testing or Ready version back to Draft. Only a Ready version is published (→ Published, the previous
// Published → Archived), on its passed gate run, which must have run every active safety case. One open version (Draft,
// Testing, Ready) per chatbot: create, copy and publish take the chatbot row's lock; save, discard and the gate moves
// lock the version row and act only from their statuses (the DAL matches them), which is enough for them. Bodies are written only through normalizeConfigBody and read for the editor through
// readConfigBody (no platform defaults). Every write records its audit row in its own transaction.
export default class ChatbotConfigsRepo {
  private db: NodePgDatabase;
  private dal: ChatbotConfigsDAL;
  private chatbotsDal: ChatbotsDAL;
  private companySecretsDal: CompanySecretsDAL;
  private evalCasesDal: EvalCasesDAL;
  private evalRunsDal: EvalRunsDAL;
  private toolDefinitionsDal: ToolDefinitionsDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new ChatbotConfigsDAL();
    this.chatbotsDal = new ChatbotsDAL();
    this.companySecretsDal = new CompanySecretsDAL();
    this.evalCasesDal = new EvalCasesDAL();
    this.evalRunsDal = new EvalRunsDAL();
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

  // DEV_NOTE: The chatbot by public id within the company; isForUpdate (create, copy, publish) serialises the writes that
  // change which version is open or live
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

    const newestRun = runs.runs[0] ?? null;
    const safety = await this.evalRunsDal.getEvalRunSafetyCases(tx, {
      companyId: params.companyId,
      evalRunIds: newestRun ? [newestRun.id] : [],
    });
    if (!safety.isSuccess || !safety.safetyCases) {
      return { isSuccess: false, message: safety.message };
    }
    const tally = newestRun
      ? EvalRunsProvider.safetyTallies([newestRun], safety.safetyCases).get(newestRun.id)
      : undefined;

    const read = Schemas.readConfigBody({ schemaVersion: row.schemaVersion, body: row.body });
    return {
      isSuccess: true,
      message: "Chatbot config fetched successfully",
      chatbotConfig: {
        ...this.toVersion(row, newestRun),
        chatbotPublicId: params.chatbot.publicId,
        body: read.isSuccess && read.body ? read.body : null,
        bodyIssue: read.isSuccess ? null : (read.message ?? "The stored config doesn't read"),
        failedSafetyCaseCount: tally ? tally.totalCount - tally.passedCount : 0,
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

  // DEV_NOTE: The version locked and checked to be in one of statuses: a write never lands on a version that left them.
  // Refused with failure (refusal = the words for this write).
  private async lockVersion(
    tx: Tx,
    params: {
      companyId: string;
      chatbot: Schemas.Chatbot;
      publicId: string;
      statuses: readonly Schemas.ChatbotConfigStatusIntEnum[];
      failure: Schemas.ChatbotConfigFailureEnum;
      refusal: string;
    },
  ): Promise<
    | { isSuccess: true; chatbotConfig: Schemas.ChatbotConfig }
    | { isSuccess: false; response: Schemas.ChatbotConfigWriteApiResponse }
  > {
    const found = await this.dal.getChatbotConfigDetails(tx, {
      companyId: params.companyId,
      chatbotId: params.chatbot.id,
      publicId: params.publicId,
      isForUpdate: true,
    });
    if (!found.isSuccess || !found.chatbotConfig) {
      return {
        isSuccess: false,
        response: { isSuccess: false, message: found.message, isNotFound: found.isNotFound },
      };
    }
    if (!params.statuses.includes(found.chatbotConfig.status)) {
      return { isSuccess: false, response: this.refuse(params.failure, params.refusal) };
    }
    return { isSuccess: true, chatbotConfig: found.chatbotConfig };
  }

  // DEV_NOTE: The version locked and checked Draft (save, discard, send to testing), else NotDraft
  private async lockDraft(
    tx: Tx,
    params: { companyId: string; chatbot: Schemas.Chatbot; publicId: string; refusal: string },
  ) {
    return await this.lockVersion(tx, {
      ...params,
      statuses: [Schemas.ChatbotConfigStatusIntEnum.Draft],
      failure: Schemas.ChatbotConfigFailureEnum.NotDraft,
    });
  }

  // DEV_NOTE: The stored body, read for a send to testing or a publish; one that no longer reads is InvalidBody
  private readStoredBody(
    chatbotConfig: Schemas.ChatbotConfig,
  ):
    | { isSuccess: true; body: Schemas.ConfigSpecBody }
    | { isSuccess: false; response: Schemas.ChatbotConfigWriteApiResponse } {
    const read = Schemas.readConfigBody({
      schemaVersion: chatbotConfig.schemaVersion,
      body: chatbotConfig.body,
    });
    if (!read.isSuccess || !read.body) {
      return {
        isSuccess: false,
        response: this.refuse(
          Schemas.ChatbotConfigFailureEnum.InvalidBody,
          read.message ?? "The stored config doesn't read",
        ),
      };
    }
    return { isSuccess: true, body: read.body };
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

  // DEV_NOTE: A body whose hash is unchanged writes nothing and records nothing
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
        const found = await this.lockDraft(tx, {
          companyId: params.companyId,
          chatbot: resolved.chatbot,
          publicId: params.publicId,
          refusal: "Only a draft can be edited; copy this version into a new draft",
        });
        if (!found.isSuccess) return found.response;
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
        const found = await this.lockDraft(tx, {
          companyId: params.companyId,
          chatbot: resolved.chatbot,
          publicId: params.publicId,
          refusal: "Only a draft can be discarded",
        });
        if (!found.isSuccess) return found.response;

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
  // provider the routing uses (the M4-10 "Done when"), a price for every model, and every pin Active. Keys and pins are
  // read FOR SHARE, so a key's invalidation, revoke or replacement and a tool's Disable wait for the publish to commit.
  // Null = all there.
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
        isForShare: true,
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

  // DEV_NOTE: Draft → Testing (M5-4): the version locked and checked Draft, its body read and its publish needs checked
  // (a config that couldn't go live isn't worth testing; publish checks them again), and its audit row. The gate run is
  // then started by the eval harness (trigger Gate), whose finish moves it to Ready or back to Draft.
  async sendChatbotConfigToTesting(
    params: ConfigScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, params);
        if (!resolved.isSuccess) return resolved.response;
        const found = await this.lockDraft(tx, {
          companyId: params.companyId,
          chatbot: resolved.chatbot,
          publicId: params.publicId,
          refusal: "Only a draft can be sent to testing",
        });
        if (!found.isSuccess) return found.response;
        const read = this.readStoredBody(found.chatbotConfig);
        if (!read.isSuccess) return read.response;
        const refused = await this.checkPublishNeeds(tx, {
          companyId: params.companyId,
          body: read.body,
        });
        if (refused) return refused;

        const moved = await this.dal.moveChatbotConfigStatus(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          id: found.chatbotConfig.id,
          fromStatuses: [Schemas.ChatbotConfigStatusIntEnum.Draft],
          status: Schemas.ChatbotConfigStatusIntEnum.Testing,
          approvedByRunId: null,
          updatedBy: params.adminId,
        });
        return await this.answerWrite(
          tx,
          params,
          resolved.chatbot,
          moved,
          Schemas.AuditEntityActionEnum.SentToTesting,
        );
      },
    );
  }

  // DEV_NOTE: Testing / Ready → Draft (M5-4): the admin takes the version back to edit it, or out of a gate run that
  // never finished. Its approval is cleared; a gate run still going for it never moves it again (it started before this).
  async moveChatbotConfigToDraft(
    params: ConfigScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, params);
        if (!resolved.isSuccess) return resolved.response;
        const found = await this.lockVersion(tx, {
          companyId: params.companyId,
          chatbot: resolved.chatbot,
          publicId: params.publicId,
          statuses: Schemas.CHATBOT_CONFIG_GATE_STATUSES,
          failure: Schemas.ChatbotConfigFailureEnum.NotInGate,
          refusal: "Only a version in testing or ready to publish can go back to draft",
        });
        if (!found.isSuccess) return found.response;

        const moved = await this.dal.moveChatbotConfigStatus(tx, {
          companyId: params.companyId,
          chatbotId: resolved.chatbot.id,
          id: found.chatbotConfig.id,
          fromStatuses: Schemas.CHATBOT_CONFIG_GATE_STATUSES,
          status: Schemas.ChatbotConfigStatusIntEnum.Draft,
          approvedByRunId: null,
          updatedBy: params.adminId,
        });
        return await this.answerWrite(
          tx,
          params,
          resolved.chatbot,
          moved,
          Schemas.AuditEntityActionEnum.MovedToDraft,
        );
      },
    );
  }

  // DEV_NOTE: The safety hard gate at publish (M5-4): the version's approved_by_run_id must be its own Done run that
  // passed (Schemas.evalRunGateDecision: threshold and every safety case), else NotApproved; and every safety case the
  // chatbot runs today (its own and the platform's, active) must be in that run's case set, else GateOutdated (one was
  // added or turned on since: the gate runs again). Null = approved.
  private async checkGateApproval(
    tx: Tx,
    params: { companyId: string; chatbotConfig: Schemas.ChatbotConfig },
  ): Promise<Schemas.ChatbotConfigWriteApiResponse | null> {
    const { chatbotConfig } = params;
    const notApproved = () =>
      this.refuse(
        Schemas.ChatbotConfigFailureEnum.NotApproved,
        "This version hasn't passed its tests; send it to testing again",
      );
    if (chatbotConfig.approvedByRunId === null) return notApproved();
    const approved = await this.evalRunsDal.getEvalRunById(tx, {
      companyId: params.companyId,
      id: chatbotConfig.approvedByRunId,
    });
    if (approved.isNotFound) return notApproved();
    if (!approved.isSuccess || !approved.evalRun) {
      return { isSuccess: false, message: approved.message };
    }
    const run = approved.evalRun;
    if (
      run.chatbotConfigId !== chatbotConfig.id ||
      run.status !== Schemas.EvalRunStatusIntEnum.Done ||
      run.hasPassed !== true
    ) {
      return notApproved();
    }

    // DEV_NOTE: One over the run limit, so a chatbot with more safety cases than a run holds is never approved by a run
    // that couldn't have held them all
    const safety = await this.evalCasesDal.getRunnableEvalCases(tx, {
      companyId: params.companyId,
      chatbotId: chatbotConfig.chatbotId,
      limit: Schemas.EVAL_RUN_MAX_CASES + 1,
      isSafetyOnly: true,
    });
    if (!safety.isSuccess || !safety.evalCases)
      return { isSuccess: false, message: safety.message };
    const ranCaseIds = new Set(run.evalCaseIds ?? []);
    if (safety.evalCases.some((evalCase) => !ranCaseIds.has(evalCase.id))) {
      return this.refuse(
        Schemas.ChatbotConfigFailureEnum.GateOutdated,
        "A safety case was added since this version was tested; send it to testing again",
      );
    }
    return null;
  }

  // DEV_NOTE: Ready → Published in one transaction: the chatbot row locked (publishes of one chatbot run one at a time),
  // the version locked and checked Ready, its gate approval checked (checkGateApproval: the safety hard gate), its needs
  // checked again (a key or tool may have changed since it was tested), the old Published version archived, this one
  // published, and its audit row. The runtime reads the Published config at every turn, so the next message uses it.
  async publishChatbotConfig(
    params: ConfigScope & { adminId: string },
  ): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ChatbotConfigWriteApiResponse>> => {
        const resolved = await this.resolveChatbot(tx, { ...params, isForUpdate: true });
        if (!resolved.isSuccess) return resolved.response;
        const found = await this.lockVersion(tx, {
          companyId: params.companyId,
          chatbot: resolved.chatbot,
          publicId: params.publicId,
          statuses: [Schemas.ChatbotConfigStatusIntEnum.Ready],
          failure: Schemas.ChatbotConfigFailureEnum.NotReady,
          refusal: "Only a version that passed its tests can be published",
        });
        if (!found.isSuccess) return found.response;
        const notApproved = await this.checkGateApproval(tx, {
          companyId: params.companyId,
          chatbotConfig: found.chatbotConfig,
        });
        if (notApproved) return notApproved;
        const read = this.readStoredBody(found.chatbotConfig);
        if (!read.isSuccess) return read.response;
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

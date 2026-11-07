import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import ChatbotsDAL from "@/data-access-layer/ChatbotsDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import CriticalEventProvider from "@/providers/criticalEvent";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The step after a contract sync made new tool versions (ADR 0009), in the caller's transaction (a self-contained
// multi-DAL step a Repo runs inside its own tx; it opens none). Nothing is published: a chatbot's live setup keeps
// the old versions until an admin sends a draft through the gate. For each chatbot with a Published config, whose pins
// (the open Draft's if there is one, else the Published ones) lag behind a replaced version:
//   1. The chatbot row is locked (as every write that changes which version is open).
//   2. An open Draft has those pins bumped (only the pins, nothing else); no open version gets a new Draft copied from the
//      Published body with them bumped; a version in testing or ready is left alone (the admin moves it back).
//   3. The chatbot's one open chatbot-wide System issue says so: a new Tool update issue, or a sentence added to the one
//      open (a quality_issue.tool_update_added event), the way ChatbotHealthProvider does for a health drop.
// It never throws a failure it can name: a step that fails comes back isSuccess false and the Repo rolls back.
export type ToolContractConfigChange = {
  chatbotName: string;
  chatbotConfig: Schemas.ChatbotConfig;
  action: Schemas.AuditEntityActionEnum.Created | Schemas.AuditEntityActionEnum.Updated;
};

export type ApplyToolContractUpdateResponse = Schemas.ApiResponse & {
  configChanges: ToolContractConfigChange[];
  outboxIds: string[];
};

export default class ToolContractUpdateProvider {
  private static configsDal = new ChatbotConfigsDAL();
  private static chatbotsDal = new ChatbotsDAL();
  private static qualityIssuesDal = new QualityIssuesDAL();

  static async apply(
    tx: NodePgTransaction<EmptyRelations>,
    params: { companyId: string; updates: Schemas.ToolUpdateEntry[] },
  ): Promise<ApplyToolContractUpdateResponse> {
    const none: ApplyToolContractUpdateResponse = {
      isSuccess: true,
      message: "No chatbot uses the replaced versions",
      configChanges: [],
      outboxIds: [],
    };
    const fail = (message: string | undefined): ApplyToolContractUpdateResponse => ({
      ...none,
      isSuccess: false,
      message: message ?? "Tool update step failed",
    });
    const { companyId, updates } = params;

    const heads = await ToolContractUpdateProvider.configsDal.getChatbotConfigHeads(tx, {
      companyId,
    });
    if (!heads.isSuccess || !heads.heads) return fail(heads.message);
    const bodies = await ToolContractUpdateProvider.configsDal.getPublishedChatbotConfigBodies(tx, {
      companyId,
    });
    if (!bodies.isSuccess || !bodies.configs) return fail(bodies.message);

    const result = {
      ...none,
      configChanges: [] as ToolContractConfigChange[],
      outboxIds: [] as string[],
    };
    for (const head of heads.heads) {
      if (head.status !== Schemas.ChatbotConfigStatusIntEnum.Published) continue;
      const stored = bodies.configs.find((config) => config.publicId === head.publicId);
      if (!stored) continue;
      const read = Schemas.readConfigBody({
        schemaVersion: stored.schemaVersion,
        body: stored.body,
      });
      if (!read.isSuccess || !read.body) continue;
      const stepped = await ToolContractUpdateProvider.applyToChatbot(tx, {
        companyId,
        chatbotId: head.chatbotId,
        published: read.body,
        updates,
      });
      if (!stepped.isSuccess) return fail(stepped.message);
      result.configChanges.push(...stepped.configChanges);
      result.outboxIds.push(...stepped.outboxIds);
    }
    return { ...result, message: "Tool updates applied" };
  }

  // DEV_NOTE: The updates a body's pins still lag behind: a pin on the tool at the replaced version or an older one (an
  // admin who skipped an update still gets the newest)
  private static lagging(
    body: Schemas.ConfigSpecBody,
    updates: Schemas.ToolUpdateEntry[],
  ): Schemas.ToolUpdateEntry[] {
    return updates.filter((update) =>
      body.tools.some((pin) => pin.name === update.name && pin.version <= update.fromVersion),
    );
  }

  private static bumpPins(
    body: Schemas.ConfigSpecBody,
    updates: Schemas.ToolUpdateEntry[],
  ): Schemas.ConfigSpecBody {
    return {
      ...body,
      tools: body.tools.map((pin) => {
        const update = updates.find(
          (candidate) => candidate.name === pin.name && pin.version <= candidate.fromVersion,
        );
        return update ? { name: pin.name, version: update.toVersion } : pin;
      }),
    };
  }

  private static async applyToChatbot(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      chatbotId: string;
      published: Schemas.ConfigSpecBody;
      updates: Schemas.ToolUpdateEntry[];
    },
  ): Promise<ApplyToolContractUpdateResponse> {
    const { companyId, chatbotId } = params;
    const empty = { configChanges: [], outboxIds: [] };
    const fail = (message: string | undefined): ApplyToolContractUpdateResponse => ({
      isSuccess: false,
      message: message ?? "Tool update step failed",
      ...empty,
    });

    const chatbot = await ToolContractUpdateProvider.chatbotsDal.getChatbotDetails(tx, {
      companyId,
      id: chatbotId,
      isForUpdate: true,
    });
    // A chatbot removed since is skipped, not a failure
    if (chatbot.isNotFound) return { isSuccess: true, message: "Chatbot is gone", ...empty };
    if (!chatbot.isSuccess || !chatbot.chatbot) return fail(chatbot.message);

    const open = await ToolContractUpdateProvider.configsDal.getLatestDraftChatbotConfig(tx, {
      companyId,
      chatbotId,
    });
    if (!open.isSuccess && !open.isNotFound) return fail(open.message);

    let draft = Schemas.ToolUpdateDraftEnum.Untouched;
    let affected: Schemas.ToolUpdateEntry[];
    const configChanges: ToolContractConfigChange[] = [];
    const openConfig = open.chatbotConfig;
    if (openConfig && openConfig.status === Schemas.ChatbotConfigStatusIntEnum.Draft) {
      const read = Schemas.readConfigBody({
        schemaVersion: openConfig.schemaVersion,
        body: openConfig.body,
      });
      if (!read.isSuccess || !read.body) return fail(read.message);
      // DEV_NOTE: A draft already on the new versions needs nothing, and no issue
      affected = ToolContractUpdateProvider.lagging(read.body, params.updates);
      if (affected.length === 0) {
        return {
          isSuccess: true,
          message: "The open draft already uses the new versions",
          ...empty,
        };
      }
      const normalized = Schemas.normalizeConfigBody(
        ToolContractUpdateProvider.bumpPins(read.body, affected),
      );
      if (!normalized.isSuccess || !normalized.body || normalized.schemaVersion === undefined) {
        return fail(normalized.message);
      }
      const saved = await ToolContractUpdateProvider.configsDal.updateChatbotConfigDraft(tx, {
        companyId,
        chatbotId,
        publicId: openConfig.publicId,
        schemaVersion: normalized.schemaVersion,
        body: normalized.body,
        bodyHash: await Utility.sha256Hex(Utility.stableStringify(normalized.body)),
        updatedBy: null,
      });
      if (!saved.isSuccess || !saved.chatbotConfig) return fail(saved.message);
      draft = Schemas.ToolUpdateDraftEnum.Updated;
      configChanges.push({
        chatbotName: chatbot.chatbot.name,
        chatbotConfig: saved.chatbotConfig,
        action: Schemas.AuditEntityActionEnum.Updated,
      });
    } else {
      affected = ToolContractUpdateProvider.lagging(params.published, params.updates);
      if (affected.length === 0) {
        return {
          isSuccess: true,
          message: "The live setup doesn't use the replaced versions",
          ...empty,
        };
      }
      if (!openConfig) {
        const state = await ToolContractUpdateProvider.configsDal.getChatbotConfigVersionState(tx, {
          companyId,
          chatbotId,
        });
        if (!state.isSuccess || state.latestVersion === undefined) return fail(state.message);
        const normalized = Schemas.normalizeConfigBody(
          ToolContractUpdateProvider.bumpPins(params.published, affected),
        );
        if (!normalized.isSuccess || !normalized.body || normalized.schemaVersion === undefined) {
          return fail(normalized.message);
        }
        const created = await ToolContractUpdateProvider.configsDal.createChatbotConfig(tx, {
          companyId,
          chatbotId,
          configVersion: state.latestVersion + 1,
          schemaVersion: normalized.schemaVersion,
          body: normalized.body,
          bodyHash: await Utility.sha256Hex(Utility.stableStringify(normalized.body)),
          createdBy: null,
        });
        if (!created.isSuccess || !created.chatbotConfig) return fail(created.message);
        draft = Schemas.ToolUpdateDraftEnum.Created;
        configChanges.push({
          chatbotName: chatbot.chatbot.name,
          chatbotConfig: created.chatbotConfig,
          action: Schemas.AuditEntityActionEnum.Created,
        });
      }
    }

    const issue = await ToolContractUpdateProvider.recordIssue(tx, {
      companyId,
      chatbotId,
      tools: affected,
      draft,
    });
    if (!issue.isSuccess) return fail(issue.message);
    return {
      isSuccess: true,
      message: "Chatbot updated",
      configChanges,
      outboxIds: issue.outboxId ? [issue.outboxId] : [],
    };
  }

  // DEV_NOTE: The chatbot's one open chatbot-wide System issue (the lookup is by what an admin can't change, so a retyped
  // one is still found): opened as a Tool update, or the sentence added to it
  private static async recordIssue(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      chatbotId: string;
      tools: Schemas.ToolUpdateEntry[];
      draft: Schemas.ToolUpdateDraftEnum;
    },
  ): Promise<Schemas.ApiResponse & { outboxId?: string }> {
    const { companyId, chatbotId, tools } = params;
    const find = { companyId, chatbotId };
    const note = Schemas.toolUpdateNote(tools, params.draft);
    const detail: Schemas.ToolUpdateDetail = { tools };
    const issueType = Schemas.QualityIssueTypeIntEnum.ToolUpdate;

    const locked =
      await ToolContractUpdateProvider.qualityIssuesDal.lockOpenChatbotWideQualityIssue(tx, find);
    if (!locked.isSuccess) return { isSuccess: false, message: locked.message };
    const open = await ToolContractUpdateProvider.qualityIssuesDal.getOpenChatbotWideQualityIssue(
      tx,
      find,
    );
    if (!open.isSuccess) return { isSuccess: false, message: open.message };

    if (open.qualityIssue) {
      const extended = await ToolContractUpdateProvider.qualityIssuesDal.updateQualityIssueNote(
        tx,
        {
          companyId,
          publicId: open.qualityIssue.publicId,
          note: Schemas.appendChatbotHealthNote(
            open.qualityIssue.note,
            note,
            Schemas.QUALITY_ISSUE_NOTE_MAX_CHARS,
          ),
        },
      );
      if (!extended.isSuccess) return { isSuccess: false, message: extended.message };
      const event = await CriticalEventProvider.record(tx, {
        companyId,
        actorType: Schemas.ActivityLogActorTypeIntEnum.System,
        actorId: null,
        entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
        entityId: open.qualityIssue.id,
        entityAction: Schemas.QualityIssueEntityActionEnum.ToolUpdateAdded,
        entityVersion: null,
        parentLogId: null,
        rootLogId: null,
        detail,
        eventType: Schemas.qualityIssueEventType(
          Schemas.QualityIssueEntityActionEnum.ToolUpdateAdded,
        ),
        dedupeKey: Schemas.qualityIssueEventDedupeKey(
          Schemas.QualityIssueEntityActionEnum.ToolUpdateAdded,
          open.qualityIssue.publicId,
          ...tools.map((tool) => `${tool.name}@${tool.toVersion}`),
        ),
      });
      if (!event.isSuccess || !event.outboxId) return { isSuccess: false, message: event.message };
      return {
        isSuccess: true,
        message: "Tool update added to the open issue",
        outboxId: event.outboxId,
      };
    }

    const created = await ToolContractUpdateProvider.qualityIssuesDal.createSystemQualityIssue(tx, {
      companyId,
      chatbotId,
      conversationId: null,
      issueType,
      note,
    });
    if (!created.isSuccess || !created.qualityIssue) {
      return { isSuccess: false, message: created.message };
    }
    const event = await CriticalEventProvider.record(tx, {
      companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: created.qualityIssue.id,
      entityAction: Schemas.QualityIssueEntityActionEnum.Opened,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail: {
        ...detail,
        source: Schemas.QualityIssueSourceIntEnum.System,
        issueType,
        conversationId: null,
      },
      eventType: Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.Opened),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        Schemas.QualityIssueEntityActionEnum.Opened,
        created.qualityIssue.publicId,
      ),
    });
    if (!event.isSuccess || !event.outboxId) return { isSuccess: false, message: event.message };
    return { isSuccess: true, message: "Tool update issue opened", outboxId: event.outboxId };
  }
}

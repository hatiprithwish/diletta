import type { EmptyRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import CompanySecretsDAL from "@/data-access-layer/CompanySecretsDAL";
import QualityIssuesDAL from "@/data-access-layer/QualityIssuesDAL";
import Constants from "@/config/Constants";
import CriticalEventProvider from "@/providers/criticalEvent";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The model router's key-failure step, in the caller's transaction (pattern rule 1.1: a provider may hold a
// self-contained multi-DAL step a Repo runs inside its own tx; it never opens one). It never throws; a failure comes back as isSuccess false and the Repo
// rolls back.
//   1. The key used (if any) is marked Invalid, only while the row still holds that exact value and is Active: a key
//      the admin replaced or revoked since is left alone, and the failure is dropped as stale.
//   2. With a conversation, the company's one open System / Model error issue covers this provider: a new issue (with
//      its quality_issue.opened critical event) when none is open, else the provider is added to the open one (a
//      sentence in its note, and a quality_issue.provider_added event). Which providers an issue covers is read from
//      those events' detail, never from the note's free text, which admins may edit.
// The advisory lock serialises concurrent failures of one company, so each provider lands on the issue once.
export default class ModelKeyFailureProvider {
  private static companySecretsDal = new CompanySecretsDAL();
  private static qualityIssuesDal = new QualityIssuesDAL();
  private static activityLogDal = new ActivityLogDAL();

  static async record(
    tx: NodePgTransaction<EmptyRelations>,
    request: Schemas.ModelKeyFailureRequest,
  ): Promise<Schemas.HandleModelKeyFailureResponse> {
    const issueType = Schemas.QualityIssueTypeIntEnum.ModelError;

    if (request.usedKey !== null) {
      const invalidated = await ModelKeyFailureProvider.companySecretsDal.invalidateModelKey(tx, {
        companyId: request.companyId,
        ...request.usedKey,
      });
      if (!invalidated.isSuccess) {
        return { isSuccess: false, message: invalidated.message };
      }
      if (!invalidated.companySecret) {
        return { isSuccess: true, message: "Model key changed since the call; nothing to do" };
      }
    }

    if (request.conversationId === null) {
      return {
        isSuccess: true,
        message: "Model key invalidated; no conversation to raise an issue on",
      };
    }

    const locked = await ModelKeyFailureProvider.qualityIssuesDal.lockOpenSystemQualityIssue(tx, {
      companyId: request.companyId,
      issueType,
    });
    if (!locked.isSuccess) {
      return { isSuccess: false, message: locked.message };
    }

    const open = await ModelKeyFailureProvider.qualityIssuesDal.getOpenSystemQualityIssue(tx, {
      companyId: request.companyId,
      issueType,
    });
    if (!open.isSuccess) {
      return { isSuccess: false, message: open.message };
    }

    const detail: Schemas.ModelKeyFailureDetail = {
      provider: request.provider,
      reason: request.reason,
    };
    const providerNote = ModelKeyFailureProvider.note(request.provider, request.reason);

    if (open.qualityIssue) {
      return await ModelKeyFailureProvider.addProvider(tx, {
        companyId: request.companyId,
        qualityIssue: open.qualityIssue,
        detail,
        providerNote,
      });
    }

    const created = await ModelKeyFailureProvider.qualityIssuesDal.createSystemQualityIssue(tx, {
      companyId: request.companyId,
      conversationId: request.conversationId,
      issueType,
      note: providerNote,
    });
    if (!created.isSuccess || !created.qualityIssue) {
      return { isSuccess: false, message: created.message };
    }
    const { qualityIssue } = created;

    const event = await CriticalEventProvider.record(tx, {
      companyId: request.companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: Schemas.QualityIssueEntityActionEnum.Opened,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail: {
        ...detail,
        source: Schemas.QualityIssueSourceIntEnum.System,
        issueType,
        conversationId: request.conversationId,
      },
      eventType: Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.Opened),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        Schemas.QualityIssueEntityActionEnum.Opened,
        qualityIssue.publicId,
      ),
    });
    if (!event.isSuccess || !event.outboxId) {
      return { isSuccess: false, message: event.message };
    }

    return {
      isSuccess: true,
      message: "System issue opened",
      qualityIssueId: qualityIssue.id,
      outboxId: event.outboxId,
    };
  }

  // DEV_NOTE: The open issue already lists the provider when one of its events names it
  private static async addProvider(
    tx: NodePgTransaction<EmptyRelations>,
    params: {
      companyId: string;
      qualityIssue: Schemas.QualityIssue;
      detail: Schemas.ModelKeyFailureDetail;
      providerNote: string;
    },
  ): Promise<Schemas.HandleModelKeyFailureResponse> {
    const { qualityIssue, detail } = params;
    const logs = await ModelKeyFailureProvider.activityLogDal.getActivityLogsByEntity(tx, {
      companyId: params.companyId,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      limit: Constants.ACTIVITY_LOGS_BY_ENTITY_LIMIT,
    });
    if (!logs.isSuccess || !logs.activityLogs) {
      return { isSuccess: false, message: logs.message };
    }
    const covered = logs.activityLogs.some((log) => {
      const logged = Schemas.ZModelKeyFailureDetail.safeParse(log.detail);
      return logged.success && logged.data.provider === detail.provider;
    });
    if (covered) {
      return { isSuccess: true, message: "A system issue for this provider is already open" };
    }

    const currentNote = qualityIssue.note ?? "";
    const extended = await ModelKeyFailureProvider.qualityIssuesDal.updateQualityIssueNote(tx, {
      companyId: params.companyId,
      publicId: qualityIssue.publicId,
      note: currentNote ? `${currentNote}\n${params.providerNote}` : params.providerNote,
    });
    if (!extended.isSuccess) {
      return { isSuccess: false, message: extended.message };
    }

    const event = await CriticalEventProvider.record(tx, {
      companyId: params.companyId,
      actorType: Schemas.ActivityLogActorTypeIntEnum.System,
      actorId: null,
      entityType: Schemas.QUALITY_ISSUE_ENTITY_TYPE,
      entityId: qualityIssue.id,
      entityAction: Schemas.QualityIssueEntityActionEnum.ProviderAdded,
      entityVersion: null,
      parentLogId: null,
      rootLogId: null,
      detail,
      eventType: Schemas.qualityIssueEventType(Schemas.QualityIssueEntityActionEnum.ProviderAdded),
      dedupeKey: Schemas.qualityIssueEventDedupeKey(
        Schemas.QualityIssueEntityActionEnum.ProviderAdded,
        qualityIssue.publicId,
        detail.provider,
      ),
    });
    if (!event.isSuccess || !event.outboxId) {
      return { isSuccess: false, message: event.message };
    }

    return {
      isSuccess: true,
      message: "Provider added to the open system issue",
      outboxId: event.outboxId,
    };
  }

  // DEV_NOTE: One sentence per provider; the open issue's note gains a sentence for each provider that fails
  private static note(
    provider: Schemas.ModelProviderEnum,
    reason: Schemas.ModelKeyFailureReasonEnum,
  ): string {
    const label = Schemas.MODEL_PROVIDER_LABEL_MAP[provider];
    return reason === Schemas.ModelKeyFailureReasonEnum.NoActiveKey
      ? `There's no active ${label} model key, so the chatbot is temporarily unavailable. Add one in Settings › Model keys.`
      : `${label} rejected the model key, so the chatbot is temporarily unavailable. Replace it in Settings › Model keys.`;
  }
}

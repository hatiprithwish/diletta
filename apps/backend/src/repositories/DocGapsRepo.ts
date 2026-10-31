import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import ConversationsDAL from "@/data-access-layer/ConversationsDAL";
import DocGapClustersDAL from "@/data-access-layer/DocGapClustersDAL";
import DocGapsDAL from "@/data-access-layer/DocGapsDAL";
import MessagesDAL from "@/data-access-layer/MessagesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import DocGapQualityProvider from "@/providers/docGapQuality";
import DocGapRewriteProvider from "@/providers/docGapRewrite";
import KnowledgeEmbedProvider from "@/providers/knowledgeEmbed";
import KnowledgeModelCallsProvider from "@/providers/knowledgeModelCalls";
import AppLogger from "@/providers/logger";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import * as Schemas from "@app/schemas";

const BACKGROUND_LINKS = { chatbotUserId: null, conversationId: null, turnId: null };

// DEV_NOTE: Doc gaps (M5-6): a candidate event from the queue becomes a stored, clustered question, or nothing. No
// transaction stays open across a model call:
//   1. read (one withTenant): the event's detail, the chat turn, the chatbot's published config
//   2. the verdict + PII-stripped rewrite, on the company's key through the model router (DocGapRewriteProvider)
//   3. one withTenant: the gap stored pending (no embedding, no group), and a conversation that closed Answered before
//      this verdict moved to Couldn't answer. From here a retry reuses the question and never pays for the rewrite again.
//   4. the question's embedding (Workers AI, platform-paid)
//   5. one withTenant under the chatbot's clustering lock: the closest Open or Dismissed group within
//      DOC_GAP_CLUSTER_MIN_SIMILARITY is joined, else a new group starts; the gap joins it; an Open group over both
//      floors opens its one Quality item (DocGapQualityProvider).
// At-least-once: UNQ_doc_gaps_message_id is the dedupe, re-checked under the lock, so a redelivered event writes nothing.
// A candidate that can't become a gap is dropped, logged, success. A failure a later try can fix answers isSuccess false,
// and the consumer retries the message.
export default class DocGapsRepo {
  private db: NodePgDatabase;
  private activityLogDal = new ActivityLogDAL();
  private chatbotConfigsDal = new ChatbotConfigsDAL();
  private companiesDal = new CompaniesDAL();
  private clustersDal = new DocGapClustersDAL();
  private conversationsDal = new ConversationsDAL();
  private gapsDal = new DocGapsDAL();
  private messagesDal = new MessagesDAL();

  constructor(
    private env: Env,
    private ctx: ExecutionContext,
  ) {
    this.db = getDbClient(env);
  }

  async processCandidate(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
  ): Promise<Schemas.ProcessDocGapCandidateResponse> {
    const inputs = await this.readInputs(event);
    if (!inputs.isSuccess) return { isSuccess: false, message: inputs.message };
    const { ready } = inputs;
    if (!ready) return this.drop(event, inputs.message ?? "Nothing to do");

    let gap = ready.pendingGap;
    if (!gap) {
      const rewritten = await this.rewrite(event, ready);
      if (!rewritten.isSuccess || !rewritten.question) return rewritten;
      const stored = await this.storePending(event, ready.detail, rewritten.question);
      if (!stored.isSuccess || !stored.docGap) return { isSuccess: false, message: stored.message };
      gap = stored.docGap;
    }
    return await this.embedAndCluster(event, ready, gap);
  }

  private async readInputs(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
  ): Promise<Schemas.DocGapCandidateInputsResponse> {
    const { companyId } = event;
    const inputs: Schemas.DocGapCandidateInputsResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.DocGapCandidateInputsResponse> => {
        const logged = await this.activityLogDal.getActivityLog(tx, {
          companyId,
          id: event.activityLogId,
        });
        if (!logged.isSuccess || !logged.activityLog) {
          return logged.isNotFound
            ? { isSuccess: true, message: "The event's log row is gone" }
            : { isSuccess: false, message: logged.message };
        }
        const parsed = Schemas.ZDocGapCandidateDetail.safeParse(logged.activityLog.detail);
        if (!parsed.success)
          return { isSuccess: true, message: "The event's detail doesn't parse" };
        const detail = parsed.data;

        const company = await this.companiesDal.getCompanyDetails(tx, { companyId });
        if (!company.isSuccess || !company.company) {
          return { isSuccess: false, message: company.message };
        }
        const companyPublicId = company.company.publicId;

        const existing = await this.gapsDal.getDocGapByMessage(tx, {
          companyId,
          messageId: detail.messageId,
        });
        if (!existing.isSuccess) return { isSuccess: false, message: existing.message };
        if (existing.docGap) {
          return existing.docGap.clusterId !== null
            ? { isSuccess: true, message: "The message already has its gap" }
            : {
                isSuccess: true,
                ready: {
                  detail,
                  companyPublicId,
                  pendingGap: existing.docGap,
                  source: null,
                  routing: null,
                },
              };
        }

        const turn = await this.messagesDal.getDocGapCandidateMessages(tx, {
          companyId,
          messageId: detail.messageId,
        });
        if (!turn.isSuccess || !turn.messages) return { isSuccess: false, message: turn.message };
        const rows = turn.messages;
        const textsOf = (role: Schemas.MessageRoleIntEnum) =>
          rows.flatMap((row) => (row.role === role && row.text ? [row.text] : []));
        const question = textsOf(Schemas.MessageRoleIntEnum.User).join("\n");
        const reply = textsOf(Schemas.MessageRoleIntEnum.Assistant).join("\n");
        const isUnreadable = rows.some(
          (row) => row.contentPurgedAt !== null || row.evalRunId !== null,
        );
        if (isUnreadable || question.length === 0 || reply.length === 0) {
          return { isSuccess: true, message: "The chat can't be read" };
        }

        const published = await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
          companyId,
          chatbotId: detail.chatbotId,
        });
        if (!published.isSuccess || !published.chatbotConfig) {
          return published.isNotFound
            ? { isSuccess: true, message: "The chatbot has no published config" }
            : { isSuccess: false, message: published.message };
        }
        const loaded = Schemas.loadConfigSpec({
          schemaVersion: published.chatbotConfig.schemaVersion,
          body: published.chatbotConfig.body,
        });
        if (!loaded.isSuccess || !loaded.spec) {
          return { isSuccess: true, message: "The published config doesn't load" };
        }

        return {
          isSuccess: true,
          ready: {
            detail,
            companyPublicId,
            pendingGap: null,
            source: { question, reply },
            routing: loaded.spec.routing,
          },
        };
      },
    );
    return inputs;
  }

  // DEV_NOTE: question set = store it. Success with no question = no gap (answered, refused, or dropped and logged).
  private async rewrite(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    ready: Schemas.DocGapCandidateReady,
  ): Promise<Schemas.ProcessDocGapCandidateResponse & { question?: string }> {
    const { companyId } = event;
    const { detail, source, routing } = ready;
    if (!source || !routing) return this.drop(event, "The chat can't be read");

    const routed = await new ModelRouterRepo(this.env, this.ctx).getModel({
      companyId,
      chatbotId: detail.chatbotId,
      ...BACKGROUND_LINKS,
      evalRunId: null,
      taskType: Schemas.ModelTaskTypeEnum.DocGapRewrite,
      tier: Schemas.ModelTierEnum.Small,
      routing,
      caps: null,
    });
    if (!routed.isSuccess) {
      const isRetryable =
        routed.failure === Schemas.ModelRouterFailureEnum.ProviderError ||
        routed.failure === Schemas.ModelRouterFailureEnum.ServerError;
      return isRetryable
        ? { isSuccess: false, message: "The model is unavailable" }
        : this.drop(event, "The model can't be used");
    }

    const rewritten = await DocGapRewriteProvider.rewrite(routed.model, source, {
      companyId,
      messageId: detail.messageId,
    });
    if (!rewritten.isSuccess) {
      return rewritten.isRetryable
        ? { isSuccess: false, message: "The rewrite failed" }
        : this.drop(event, "The rewrite's model can't be used");
    }
    return rewritten.question === null
      ? { isSuccess: true, message: "No doc gap", isDropped: true }
      : { isSuccess: true, message: "Rewritten", question: rewritten.question };
  }

  // DEV_NOTE: The verdict is in: the question is kept for any retry, and a conversation that closed before the verdict
  // gets the outcome closeConversation would have given it. A concurrent delivery of the same event loses on the unique
  // message id and retries, then finds this row.
  private async storePending(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    detail: Schemas.DocGapCandidateDetail,
    question: string,
  ): Promise<Schemas.DocGapDALResponse> {
    const { companyId } = event;
    const stored: Schemas.DocGapDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.DocGapDALResponse> => {
        const created = await this.gapsDal.createDocGap(tx, {
          companyId,
          chatbotId: detail.chatbotId,
          conversationId: detail.conversationId,
          messageId: detail.messageId,
          questionGeneric: question,
          signal: detail.signal,
        });
        if (!created.isSuccess) throw new TenantRollbackError(created.message);

        const last = await this.gapsDal.hasDocGapOnLastUserMessage(tx, {
          companyId,
          conversationId: detail.conversationId,
        });
        if (!last.isSuccess) throw new TenantRollbackError(last.message);
        if (last.hasDocGap) {
          const marked = await this.conversationsDal.markClosedConversationUnanswered(tx, {
            companyId,
            id: detail.conversationId,
          });
          if (!marked.isSuccess) throw new TenantRollbackError(marked.message);
        }
        return created;
      },
    );
    return stored;
  }

  private async embedAndCluster(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    ready: Schemas.DocGapCandidateReady,
    gap: Schemas.DocGap,
  ): Promise<Schemas.ProcessDocGapCandidateResponse> {
    const { companyId } = event;
    const { detail } = ready;
    const question = gap.questionGeneric;
    const price = KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_EMBEDDING_MODEL);
    if (!price) return this.drop(event, "The embedding model has no price");

    const embedded = await KnowledgeEmbedProvider.embed(this.env, {
      companyPublicId: ready.companyPublicId,
      taskType: Schemas.ModelTaskTypeEnum.DocGapEmbed,
      texts: [question],
    });
    const embedding = embedded.embeddings?.[0];
    const callRecord = {
      companyId,
      links: { chatbotId: detail.chatbotId, ...BACKGROUND_LINKS },
      taskType: Schemas.ModelTaskTypeEnum.DocGapEmbed as const,
      model: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
      price,
      calls: embedded.calls ?? [],
    };

    if (!embedded.isSuccess || !embedding) {
      await this.recordFailedEmbedCalls(event, detail, callRecord);
      return { isSuccess: false, message: embedded.message ?? "The embedding failed" };
    }

    const written: Schemas.ProcessDocGapCandidateResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.ProcessDocGapCandidateResponse> => {
        const recorded = await KnowledgeModelCallsProvider.record(tx, callRecord);
        if (!recorded.isSuccess) throw new TenantRollbackError(recorded.message);

        const locked = await this.clustersDal.lockDocGapClustering(tx, {
          companyId,
          chatbotId: detail.chatbotId,
        });
        if (!locked.isSuccess) throw new TenantRollbackError(locked.message);

        const existing = await this.gapsDal.getDocGapByMessage(tx, {
          companyId,
          messageId: detail.messageId,
        });
        if (!existing.isSuccess) throw new TenantRollbackError(existing.message);
        if (!existing.docGap || existing.docGap.clusterId !== null) {
          return { isSuccess: true, message: "The message already has its gap", isDropped: true };
        }

        const nearest = await this.clustersDal.findNearestDocGapCluster(tx, {
          companyId,
          chatbotId: detail.chatbotId,
          embedding,
        });
        if (!nearest.isSuccess) throw new TenantRollbackError(nearest.message);

        const match = nearest.docGapCluster;
        let cluster: Schemas.DocGapCluster;
        if (match && match.similarity >= Schemas.DOC_GAP_CLUSTER_MIN_SIMILARITY) {
          const grown = await this.clustersDal.growDocGapCluster(tx, {
            companyId,
            id: match.id,
            questionCount: match.questionCount + 1,
            centroid: Schemas.nextDocGapCentroid(match.centroid, match.questionCount, embedding),
          });
          if (!grown.isSuccess || !grown.docGapCluster) {
            throw new TenantRollbackError(grown.message ?? "Doc gap cluster not grown");
          }
          cluster = grown.docGapCluster;
        } else {
          const created = await this.clustersDal.createDocGapCluster(tx, {
            companyId,
            chatbotId: detail.chatbotId,
            label: question,
            centroid: embedding,
          });
          if (created.isNotFound) {
            return { isSuccess: true, message: "The chatbot was removed", isDropped: true };
          }
          if (!created.isSuccess || !created.docGapCluster) {
            throw new TenantRollbackError(created.message ?? "Doc gap cluster not created");
          }
          cluster = created.docGapCluster;
        }

        const attached = await this.gapsDal.attachDocGapToCluster(tx, {
          companyId,
          id: existing.docGap.id,
          clusterId: cluster.id,
          embedding,
        });
        if (!attached.isSuccess) throw new TenantRollbackError(attached.message);

        const counted = await this.gapsDal.countDocGapUsers(tx, {
          companyId,
          clusterId: cluster.id,
        });
        if (!counted.isSuccess) throw new TenantRollbackError(counted.message);

        const opensIssue = Schemas.docGapClusterOpensQualityIssue({
          isOpen: cluster.status === Schemas.DocGapClusterStatusIntEnum.Open,
          questionCount: cluster.questionCount,
          userCount: counted.userCount ?? 0,
        });
        if (!opensIssue) {
          return { isSuccess: true, message: "Doc gap stored", isGap: true };
        }

        const opened = await DocGapQualityProvider.open(tx, {
          companyId,
          chatbotId: detail.chatbotId,
          docGapClusterId: cluster.id,
          label: cluster.label,
        });
        // DEV_NOTE: A chatbot removed since the question: the gap stays, with no item to open on it
        if (!opened.isSuccess && !opened.isNotFound) {
          throw new TenantRollbackError(opened.message ?? "Quality item not opened");
        }
        return {
          isSuccess: true,
          message: "Doc gap stored",
          isGap: true,
          qualityIssueOpened: opened.isOpened ?? false,
          outboxIds: opened.outboxId ? [opened.outboxId] : [],
        };
      },
    );

    if (written.outboxIds && written.outboxIds.length > 0) {
      this.ctx.waitUntil(
        new EventOutboxRepo(this.env).relayEvents({ companyId, outboxIds: written.outboxIds }),
      );
    }
    return written;
  }

  // DEV_NOTE: A failed embed's calls are still paid for: their rows go in on their own (none made = no transaction), and
  // a failed write is logged here since the message then retries for another reason
  private async recordFailedEmbedCalls(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    detail: Schemas.DocGapCandidateDetail,
    callRecord: Parameters<typeof KnowledgeModelCallsProvider.record>[1],
  ): Promise<void> {
    if (callRecord.calls.length === 0) return;
    const { companyId } = event;
    const recorded = await withTenant(this.db, companyId, async (tx) => {
      return await KnowledgeModelCallsProvider.record(tx, callRecord);
    });
    if (!recorded.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.ProcessDocGapCandidate,
        message: recorded.message ?? "Failed embed's model calls not recorded",
        metadata: { companyId, messageId: detail.messageId },
      });
    }
  }

  private drop(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    message: string,
  ): Schemas.ProcessDocGapCandidateResponse {
    AppLogger.warn({
      category: Schemas.LogCategory.Knowledge,
      action: Schemas.LogAction.ProcessDocGapCandidate,
      message: `Doc gap candidate dropped: ${message}`,
      metadata: { companyId: event.companyId, activityLogId: event.activityLogId },
    });
    return { isSuccess: true, message, isDropped: true };
  }
}

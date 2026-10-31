import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
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

type CandidateInputs =
  | { isSuccess: false; message?: string; isDropped?: undefined }
  | { isSuccess: true; isDropped: true; message: string }
  | {
      isSuccess: true;
      isDropped: false;
      detail: Schemas.DocGapCandidateDetail;
      source: Schemas.DocGapRewriteSource;
      routing: Schemas.ConfigSpec["routing"];
      companyPublicId: string;
    };

// DEV_NOTE: Doc gaps (M5-6): a candidate event from the queue becomes a stored, clustered question, or nothing. No
// transaction stays open across a model call:
//   1. read (one withTenant): the event's detail, the chat turn, the chatbot's published config
//   2. the verdict + PII-stripped rewrite, on the company's key through the model router (DocGapRewriteProvider)
//   3. the question's embedding (Workers AI, platform-paid)
//   4. one withTenant under the chatbot's clustering lock: the closest Open or Dismissed group within
//      DOC_GAP_CLUSTER_MIN_SIMILARITY is joined, else a new group starts; the gap is stored; an Open group over both
//      floors opens its one Quality item (DocGapQualityProvider).
// At-least-once: UNQ_doc_gaps_message_id is the dedupe, checked under the lock, so a redelivered event writes nothing.
// A candidate that can't become a gap is dropped, logged, success. A failure a later try can fix answers isSuccess false,
// and the consumer retries the message.
export default class DocGapsRepo {
  private db: NodePgDatabase;
  private activityLogDal = new ActivityLogDAL();
  private chatbotConfigsDal = new ChatbotConfigsDAL();
  private companiesDal = new CompaniesDAL();
  private clustersDal = new DocGapClustersDAL();
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
    const { companyId } = event;
    const inputs = await this.readInputs(event);
    if (!inputs.isSuccess) return { isSuccess: false, message: inputs.message };
    if (inputs.isDropped) return this.drop(event, inputs.message);
    const { detail } = inputs;
    const logMetadata = { companyId, messageId: detail.messageId };

    const routed = await new ModelRouterRepo(this.env, this.ctx).getModel({
      companyId,
      chatbotId: detail.chatbotId,
      ...BACKGROUND_LINKS,
      evalRunId: null,
      taskType: Schemas.ModelTaskTypeEnum.DocGapRewrite,
      tier: Schemas.ModelTierEnum.Small,
      routing: inputs.routing,
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

    const rewritten = await DocGapRewriteProvider.rewrite(routed.model, inputs.source, logMetadata);
    if (!rewritten.isSuccess) {
      return rewritten.isRetryable
        ? { isSuccess: false, message: "The rewrite failed" }
        : this.drop(event, "The rewrite's model can't be used");
    }
    if (rewritten.question === null) {
      return { isSuccess: true, message: "No doc gap", isDropped: true };
    }

    return await this.embedAndCluster(event, inputs, rewritten.question);
  }

  private async readInputs(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
  ): Promise<CandidateInputs> {
    const { companyId } = event;
    const inputs = await withTenant(this.db, companyId, async (tx): Promise<CandidateInputs> => {
      const logged = await this.activityLogDal.getActivityLog(tx, {
        companyId,
        id: event.activityLogId,
      });
      if (!logged.isSuccess || !logged.activityLog) {
        return logged.isNotFound
          ? { isSuccess: true, isDropped: true, message: "The event's log row is gone" }
          : { isSuccess: false, message: logged.message };
      }
      const parsed = Schemas.ZDocGapCandidateDetail.safeParse(logged.activityLog.detail);
      if (!parsed.success) {
        return { isSuccess: true, isDropped: true, message: "The event's detail doesn't parse" };
      }
      const detail = parsed.data;

      const existing = await this.gapsDal.getDocGapByMessage(tx, {
        companyId,
        messageId: detail.messageId,
      });
      if (!existing.isSuccess) return { isSuccess: false, message: existing.message };
      if (existing.docGap) {
        return { isSuccess: true, isDropped: true, message: "The message already has its gap" };
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
        return { isSuccess: true, isDropped: true, message: "The chat can't be read" };
      }

      const published = await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
        companyId,
        chatbotId: detail.chatbotId,
      });
      if (!published.isSuccess || !published.chatbotConfig) {
        return published.isNotFound
          ? { isSuccess: true, isDropped: true, message: "The chatbot has no published config" }
          : { isSuccess: false, message: published.message };
      }
      const loaded = Schemas.loadConfigSpec({
        schemaVersion: published.chatbotConfig.schemaVersion,
        body: published.chatbotConfig.body,
      });
      if (!loaded.isSuccess || !loaded.spec) {
        return { isSuccess: true, isDropped: true, message: "The published config doesn't load" };
      }

      const company = await this.companiesDal.getCompanyDetails(tx, { companyId });
      if (!company.isSuccess || !company.company) {
        return { isSuccess: false, message: company.message };
      }

      return {
        isSuccess: true,
        isDropped: false,
        detail,
        source: { question, reply },
        routing: loaded.spec.routing,
        companyPublicId: company.company.publicId,
      };
    });
    return inputs.isSuccess && "isDropped" in inputs
      ? (inputs as CandidateInputs)
      : { isSuccess: false, message: inputs.message };
  }

  private async embedAndCluster(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    inputs: Extract<CandidateInputs, { isDropped: false }>,
    question: string,
  ): Promise<Schemas.ProcessDocGapCandidateResponse> {
    const { companyId } = event;
    const { detail } = inputs;
    const price = KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_EMBEDDING_MODEL);
    if (!price) return this.drop(event, "The embedding model has no price");

    const embedded = await KnowledgeEmbedProvider.embed(this.env, {
      companyPublicId: inputs.companyPublicId,
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

    // DEV_NOTE: A failed embed's calls are still paid for: their rows go in on their own, then the message retries
    if (!embedded.isSuccess || !embedding) {
      await withTenant(this.db, companyId, async (tx) => {
        return await KnowledgeModelCallsProvider.record(tx, callRecord);
      });
      return { isSuccess: false, message: embedded.message ?? "The embedding failed" };
    }

    const written = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.ProcessDocGapCandidateResponse>> => {
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
        if (existing.docGap) {
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

        const gap = await this.gapsDal.createDocGap(tx, {
          companyId,
          chatbotId: detail.chatbotId,
          conversationId: detail.conversationId,
          messageId: detail.messageId,
          questionGeneric: question,
          signal: detail.signal,
          embedding,
          clusterId: cluster.id,
        });
        if (!gap.isSuccess) throw new TenantRollbackError(gap.message);

        const counted = await this.gapsDal.countDocGapConversations(tx, {
          companyId,
          clusterId: cluster.id,
        });
        if (!counted.isSuccess) throw new TenantRollbackError(counted.message);

        const opensIssue = Schemas.docGapClusterOpensQualityIssue({
          isOpen: cluster.status === Schemas.DocGapClusterStatusIntEnum.Open,
          questionCount: cluster.questionCount,
          conversationCount: counted.conversationCount ?? 0,
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

    if ("outboxIds" in written && written.outboxIds && written.outboxIds.length > 0) {
      this.ctx.waitUntil(
        new EventOutboxRepo(this.env).relayEvents({ companyId, outboxIds: written.outboxIds }),
      );
    }
    return written;
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

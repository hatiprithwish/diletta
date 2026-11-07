import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import ActivityLogDAL from "@/data-access-layer/ActivityLogDAL";
import ChatbotConfigsDAL from "@/data-access-layer/ChatbotConfigsDAL";
import CompaniesDAL from "@/data-access-layer/CompaniesDAL";
import FeedbackNotesDAL from "@/data-access-layer/FeedbackNotesDAL";
import FeedbackThemesDAL from "@/data-access-layer/FeedbackThemesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import FeedbackNoteRewriteProvider from "@/providers/feedbackNoteRewrite";
import FeedbackThemeQualityProvider from "@/providers/feedbackThemeQuality";
import KnowledgeEmbedProvider from "@/providers/knowledgeEmbed";
import KnowledgeModelCallsProvider from "@/providers/knowledgeModelCalls";
import AppLogger from "@/providers/logger";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import ModelRouterRepo from "@/repositories/ModelRouterRepo";
import * as Schemas from "@app/schemas";

const BACKGROUND_LINKS = { chatbotUserId: null, conversationId: null, turnId: null };

// DEV_NOTE: Feedback themes (M7-10): a feedback.note_added event from the queue becomes a grouped note summary, or
// nothing. Mirrors DocGapsRepo; no transaction stays open across a model call:
//   1. read (one withTenant): the event's detail, the feedback row (its note now and its version), the reply it rates,
//      the chatbot's published config. A note gone (a thumb switch, the purge) or edited since the event is dropped:
//      the newer version has its own event.
//   2. the summary, on the company's key through the model router (FeedbackNoteRewriteProvider). Not specific = dropped.
//   3. one withTenant: the summary stored pending (no embedding, no theme), replacing an earlier version's (which leaves
//      its theme). From here a retry reuses it and never pays for the rewrite again.
//   4. the summary's embedding (Workers AI, platform-paid)
//   5. one withTenant under the chatbot's and thumb's theming lock: the closest Open or Dismissed theme of the same
//      thumb within FEEDBACK_THEME_MIN_SIMILARITY is joined, else a new one starts; the note joins it; an Open Didn't like
//      theme over both floors opens its one Quality item (FeedbackThemeQualityProvider).
// At-least-once: the note's version is re-checked under the lock, so a redelivered event writes nothing. A note that
// can't be grouped is dropped, logged, success. A failure a later try can fix answers isSuccess false, and the consumer
// retries the message. Note text and summaries are never logged.
export default class FeedbackThemesRepo {
  private db: NodePgDatabase;
  private activityLogDal = new ActivityLogDAL();
  private chatbotConfigsDal = new ChatbotConfigsDAL();
  private companiesDal = new CompaniesDAL();
  private notesDal = new FeedbackNotesDAL();
  private themesDal = new FeedbackThemesDAL();

  constructor(
    private env: Env,
    private ctx: ExecutionContext,
  ) {
    this.db = getDbClient(env);
  }

  async processNote(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
  ): Promise<Schemas.ProcessFeedbackNoteResponse> {
    const inputs = await this.readInputs(event);
    if (!inputs.isSuccess) return { isSuccess: false, message: inputs.message };
    const { ready } = inputs;
    if (!ready) return this.drop(event, inputs.message ?? "Nothing to do");

    let note = ready.pendingNote;
    if (!note) {
      const rewritten = await this.rewrite(event, ready);
      if (!rewritten.isSuccess || !rewritten.summary) return rewritten;
      const stored = await this.storePending(event, ready, rewritten.summary);
      if (!stored.isSuccess) return { isSuccess: false, message: stored.message };
      if (!stored.feedbackNote) return this.drop(event, stored.message ?? "A newer note is stored");
      note = stored.feedbackNote;
    }
    return await this.embedAndTheme(event, ready, note);
  }

  private async readInputs(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
  ): Promise<Schemas.FeedbackNoteInputsResponse> {
    const { companyId } = event;
    const inputs: Schemas.FeedbackNoteInputsResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.FeedbackNoteInputsResponse> => {
        const logged = await this.activityLogDal.getActivityLog(tx, {
          companyId,
          id: event.activityLogId,
        });
        if (!logged.isSuccess || !logged.activityLog) {
          return logged.isNotFound
            ? { isSuccess: true, message: "The event's log row is gone" }
            : { isSuccess: false, message: logged.message };
        }
        const parsed = Schemas.ZFeedbackNoteAddedDetail.safeParse(logged.activityLog.detail);
        if (!parsed.success) {
          return { isSuccess: true, message: "The event's detail doesn't parse" };
        }
        const detail = parsed.data;

        const found = await this.notesDal.getFeedbackNoteSource(tx, {
          companyId,
          feedbackId: detail.feedbackId,
        });
        if (!found.isSuccess || !found.source) {
          return found.isNotFound
            ? { isSuccess: true, message: "The rating is gone" }
            : { isSuccess: false, message: found.message };
        }
        const { source } = found;
        if (source.comment === null || source.commentVersion !== detail.commentVersion) {
          return { isSuccess: true, message: "The note was cleared or edited since" };
        }
        if (source.isEval) return { isSuccess: true, message: "An eval conversation's note" };
        const note = {
          rating: source.rating,
          chatbotUserId: source.chatbotUserId,
          conversationId: source.conversationId,
          chatbotId: source.chatbotId,
        };

        const company = await this.companiesDal.getCompanyDetails(tx, { companyId });
        if (!company.isSuccess || !company.company) {
          return { isSuccess: false, message: company.message };
        }
        const companyPublicId = company.company.publicId;

        const existing = await this.notesDal.getFeedbackNoteByFeedback(tx, {
          companyId,
          feedbackId: detail.feedbackId,
        });
        if (!existing.isSuccess) return { isSuccess: false, message: existing.message };
        if (existing.feedbackNote?.commentVersion === detail.commentVersion) {
          return existing.feedbackNote.themeId !== null
            ? { isSuccess: true, message: "The note already has its theme" }
            : {
                isSuccess: true,
                ready: {
                  detail,
                  companyPublicId,
                  note,
                  pendingNote: existing.feedbackNote,
                  source: null,
                  routing: null,
                },
              };
        }

        // DEV_NOTE: The DO refused a note holding a prompt injection; this holds for one stored before that check
        if (Schemas.detectPromptInjection(source.comment).isDetected) {
          return { isSuccess: true, message: "The note holds a prompt injection" };
        }

        const published = await this.chatbotConfigsDal.getPublishedChatbotConfig(tx, {
          companyId,
          chatbotId: source.chatbotId,
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
            note,
            pendingNote: null,
            source: { note: source.comment, rating: source.rating, reply: source.replyText ?? "" },
            routing: loaded.spec.routing,
          },
        };
      },
    );
    return inputs;
  }

  // DEV_NOTE: summary set = store it. Success with no summary = nothing to group (not specific, or dropped and logged).
  private async rewrite(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    ready: Schemas.FeedbackNoteReady,
  ): Promise<Schemas.ProcessFeedbackNoteResponse & { summary?: string }> {
    const { companyId } = event;
    const { source, routing } = ready;
    if (!source || !routing) return this.drop(event, "The note can't be read");

    const routed = await new ModelRouterRepo(this.env, this.ctx).getModel({
      companyId,
      chatbotId: ready.note.chatbotId,
      ...BACKGROUND_LINKS,
      evalRunId: null,
      taskType: Schemas.ModelTaskTypeEnum.FeedbackNoteRewrite,
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

    const rewritten = await FeedbackNoteRewriteProvider.rewrite(routed.model, source, {
      companyId,
      feedbackId: ready.detail.feedbackId,
    });
    if (!rewritten.isSuccess) {
      return rewritten.isRetryable
        ? { isSuccess: false, message: "The rewrite failed" }
        : this.drop(event, "The rewrite's model can't be used");
    }
    return rewritten.summary === null
      ? this.drop(event, "The note says nothing specific")
      : { isSuccess: true, message: "Rewritten", summary: rewritten.summary };
  }

  // DEV_NOTE: The summary is in: stored pending, replacing an earlier version's (which leaves its theme). Re-checked in
  // this transaction: a note edited or cleared while the model read it is left to its own event (no note returned).
  private async storePending(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    ready: Schemas.FeedbackNoteReady,
    summary: string,
  ): Promise<Schemas.FeedbackNoteDALResponse> {
    const { companyId } = event;
    const { detail, note } = ready;
    const stored: Schemas.FeedbackNoteDALResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.FeedbackNoteDALResponse> => {
        const found = await this.notesDal.getFeedbackNoteSource(tx, {
          companyId,
          feedbackId: detail.feedbackId,
        });
        if (!found.isSuccess && !found.isNotFound) throw new TenantRollbackError(found.message);
        const isCurrent =
          found.source?.comment !== null && found.source?.commentVersion === detail.commentVersion;
        if (!isCurrent) return { isSuccess: true, message: "The note was cleared or edited since" };

        const existing = await this.notesDal.getFeedbackNoteByFeedback(tx, {
          companyId,
          feedbackId: detail.feedbackId,
        });
        if (!existing.isSuccess) throw new TenantRollbackError(existing.message);
        if (existing.feedbackNote?.themeId) {
          const shrunk = await this.themesDal.shrinkFeedbackTheme(tx, {
            companyId,
            id: existing.feedbackNote.themeId,
          });
          if (!shrunk.isSuccess) throw new TenantRollbackError(shrunk.message);
        }

        const saved = await this.notesDal.upsertFeedbackNote(tx, {
          companyId,
          chatbotId: note.chatbotId,
          feedbackId: detail.feedbackId,
          conversationId: note.conversationId,
          chatbotUserId: note.chatbotUserId,
          rating: note.rating,
          commentVersion: detail.commentVersion,
          summary,
        });
        if (!saved.isSuccess) throw new TenantRollbackError(saved.message);
        return saved;
      },
    );
    return stored;
  }

  private async embedAndTheme(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    ready: Schemas.FeedbackNoteReady,
    pending: Schemas.FeedbackNote,
  ): Promise<Schemas.ProcessFeedbackNoteResponse> {
    const { companyId } = event;
    const { detail, note } = ready;
    const price = KnowledgeModelCallsProvider.price(Schemas.KNOWLEDGE_EMBEDDING_MODEL);
    if (!price) return this.drop(event, "The embedding model has no price");

    const embedded = await KnowledgeEmbedProvider.embed(this.env, {
      companyPublicId: ready.companyPublicId,
      taskType: Schemas.ModelTaskTypeEnum.FeedbackNoteEmbed,
      texts: [pending.summary],
    });
    const embedding = embedded.embeddings?.[0];
    const callRecord = {
      companyId,
      links: { chatbotId: note.chatbotId, ...BACKGROUND_LINKS },
      taskType: Schemas.ModelTaskTypeEnum.FeedbackNoteEmbed as const,
      model: Schemas.KNOWLEDGE_EMBEDDING_MODEL,
      price,
      calls: embedded.calls ?? [],
    };

    if (!embedded.isSuccess || !embedding) {
      await this.recordFailedEmbedCalls(event, detail, callRecord);
      return { isSuccess: false, message: embedded.message ?? "The embedding failed" };
    }

    const written: Schemas.ProcessFeedbackNoteResponse = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.ProcessFeedbackNoteResponse> => {
        const recorded = await KnowledgeModelCallsProvider.record(tx, callRecord);
        if (!recorded.isSuccess) throw new TenantRollbackError(recorded.message);

        const locked = await this.themesDal.lockFeedbackTheming(tx, {
          companyId,
          chatbotId: note.chatbotId,
          rating: note.rating,
        });
        if (!locked.isSuccess) throw new TenantRollbackError(locked.message);

        const existing = await this.notesDal.getFeedbackNoteByFeedback(tx, {
          companyId,
          feedbackId: detail.feedbackId,
        });
        if (!existing.isSuccess) throw new TenantRollbackError(existing.message);
        const current = existing.feedbackNote;
        if (
          !current ||
          current.themeId !== null ||
          current.commentVersion !== detail.commentVersion
        ) {
          return { isSuccess: true, message: "The note already has its theme", isDropped: true };
        }

        const nearest = await this.themesDal.findNearestFeedbackTheme(tx, {
          companyId,
          chatbotId: note.chatbotId,
          rating: note.rating,
          embedding,
        });
        if (!nearest.isSuccess) throw new TenantRollbackError(nearest.message);

        const match = nearest.feedbackTheme;
        let theme: Schemas.FeedbackTheme;
        if (match && match.similarity >= Schemas.FEEDBACK_THEME_MIN_SIMILARITY) {
          const grown = await this.themesDal.growFeedbackTheme(tx, {
            companyId,
            id: match.id,
            noteCount: match.noteCount + 1,
            centroid: Schemas.nextFeedbackThemeCentroid(match.centroid, match.noteCount, embedding),
          });
          if (!grown.isSuccess || !grown.feedbackTheme) {
            throw new TenantRollbackError(grown.message ?? "Feedback theme not grown");
          }
          theme = grown.feedbackTheme;
        } else {
          const created = await this.themesDal.createFeedbackTheme(tx, {
            companyId,
            chatbotId: note.chatbotId,
            rating: note.rating,
            label: current.summary,
            centroid: embedding,
          });
          if (created.isNotFound) {
            return { isSuccess: true, message: "The chatbot was removed", isDropped: true };
          }
          if (!created.isSuccess || !created.feedbackTheme) {
            throw new TenantRollbackError(created.message ?? "Feedback theme not created");
          }
          theme = created.feedbackTheme;
        }

        const attached = await this.notesDal.attachFeedbackNote(tx, {
          companyId,
          id: current.id,
          themeId: theme.id,
          embedding,
        });
        if (!attached.isSuccess) throw new TenantRollbackError(attached.message);

        const counted = await this.notesDal.countFeedbackThemeUsers(tx, {
          companyId,
          themeId: theme.id,
        });
        if (!counted.isSuccess) throw new TenantRollbackError(counted.message);

        const opensIssue = Schemas.feedbackThemeOpensQualityIssue({
          rating: theme.rating,
          isOpen: theme.status === Schemas.FeedbackThemeStatusIntEnum.Open,
          noteCount: theme.noteCount,
          userCount: counted.userCount ?? 0,
        });
        if (!opensIssue) {
          return { isSuccess: true, message: "Feedback note themed", isThemed: true };
        }

        const opened = await FeedbackThemeQualityProvider.open(tx, {
          companyId,
          chatbotId: note.chatbotId,
          feedbackThemeId: theme.id,
          label: theme.label,
        });
        // DEV_NOTE: A chatbot removed since the note: the theme stays, with no item to open on it
        if (!opened.isSuccess && !opened.isNotFound) {
          throw new TenantRollbackError(opened.message ?? "Quality item not opened");
        }
        return {
          isSuccess: true,
          message: "Feedback note themed",
          isThemed: true,
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
    detail: Schemas.FeedbackNoteAddedDetail,
    callRecord: Parameters<typeof KnowledgeModelCallsProvider.record>[1],
  ): Promise<void> {
    if (callRecord.calls.length === 0) return;
    const { companyId } = event;
    const recorded = await withTenant(this.db, companyId, async (tx) => {
      return await KnowledgeModelCallsProvider.record(tx, callRecord);
    });
    if (!recorded.isSuccess) {
      AppLogger.error({
        category: Schemas.LogCategory.Feedback,
        action: Schemas.LogAction.ProcessFeedbackNote,
        message: recorded.message ?? "Failed embed's model calls not recorded",
        metadata: { companyId, feedbackId: detail.feedbackId },
      });
    }
  }

  private drop(
    event: Pick<Schemas.EventOutboxMessage, "companyId" | "activityLogId">,
    message: string,
  ): Schemas.ProcessFeedbackNoteResponse {
    AppLogger.warn({
      category: Schemas.LogCategory.Feedback,
      action: Schemas.LogAction.ProcessFeedbackNote,
      message: `Feedback note dropped: ${message}`,
      metadata: { companyId: event.companyId, activityLogId: event.activityLogId },
    });
    return { isSuccess: true, message, isDropped: true };
  }
}

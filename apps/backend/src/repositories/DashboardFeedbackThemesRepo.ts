import type { EmptyRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import Constants from "@/config/Constants";
import FeedbackThemesDAL from "@/data-access-layer/FeedbackThemesDAL";
import getDbClient from "@/db/dbClient";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import FeedbackThemeQualityProvider from "@/providers/feedbackThemeQuality";
import AppLogger from "@/providers/logger";
import { recordAuditOrRollback } from "@/repositories/audit";
import * as Schemas from "@app/schemas";

type Tx = NodePgTransaction<EmptyRelations>;

// DEV_NOTE: Tenant Repo — the feedback themes as Quality › User feedback works them (M7-10): the list with its tab and
// thumb counts, one theme with its newest notes, Resolve and Dismiss. Both start from Open under the theme's row lock and
// end it (no reopen by hand), record the admin's audit row and close the Quality item the theme opened, all in one
// withTenant, the theme read back in it. The clustering that writes themes and notes is FeedbackThemesRepo.
export default class DashboardFeedbackThemesRepo {
  private db: NodePgDatabase;
  private dal: FeedbackThemesDAL;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.dal = new FeedbackThemesDAL();
  }

  // DEV_NOTE: Status Enum Pattern — status and thumb as int + label; internal ids dropped
  private toListItem(row: Schemas.FeedbackThemeRow): Schemas.FeedbackThemeListItem {
    return {
      publicId: row.publicId,
      chatbotName: row.chatbotName,
      label: row.label,
      rating: row.rating,
      ratingLabel: Schemas.FEEDBACK_RATING_LABEL_MAP[row.rating],
      feedbackThemeStatus: row.status,
      feedbackThemeStatusLabel: Schemas.FEEDBACK_THEME_STATUS_LABEL_MAP[row.status],
      noteCount: row.noteCount,
      userCount: row.userCount,
      latestSummary: row.latestSummary,
      latestNoteAt: row.latestNoteAt?.toISOString() ?? null,
      qualityIssuePublicId: row.qualityIssuePublicId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getFeedbackThemes(
    params: Schemas.GetFeedbackThemesApiRequest & { companyId: string },
  ): Promise<Schemas.GetFeedbackThemesApiResponse> {
    const { companyId } = params;
    return await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.GetFeedbackThemesApiResponse> => {
        const tab = params.tab ?? Schemas.FeedbackThemeListTabEnum.Open;
        const ratingFilter = params.rating ?? Schemas.FeedbackThemeRatingFilterEnum.Disliked;
        const status = Schemas.FEEDBACK_THEME_TAB_STATUS[tab];
        const rating = Schemas.FEEDBACK_THEME_RATING_FILTER_RATING[ratingFilter];
        const page = await this.dal.getFeedbackThemes(tx, {
          companyId,
          rating,
          status,
          pageNo: params.pageNo ?? Constants.DEFAULT_PAGE_NO,
          pageSize: params.pageSize ?? Constants.DEFAULT_PAGE_SIZE,
          sortColumn: params.sortColumn ?? Schemas.FeedbackThemeSortColumn.NoteCount,
          sortDirection: params.sortDirection ?? Schemas.SortDirection.Desc,
        });
        if (!page.isSuccess || !page.feedbackThemes) {
          return { isSuccess: false, message: page.message };
        }

        const counted = await this.dal.countFeedbackThemes(tx, { companyId });
        if (!counted.isSuccess || !counted.counts) {
          return { isSuccess: false, message: counted.message };
        }
        const { counts } = counted;
        const tabCounts = Object.fromEntries(
          Object.values(Schemas.FeedbackThemeListTabEnum).map((each) => [
            each,
            counts[Schemas.FEEDBACK_THEME_TAB_STATUS[each]][rating],
          ]),
        ) as Schemas.FeedbackThemeTabCounts;
        const ratingCounts = Object.fromEntries(
          Object.values(Schemas.FeedbackThemeRatingFilterEnum).map((each) => [
            each,
            counts[status][Schemas.FEEDBACK_THEME_RATING_FILTER_RATING[each]],
          ]),
        ) as Schemas.FeedbackThemeRatingCounts;

        return {
          isSuccess: true,
          message: "Feedback themes fetched successfully",
          feedbackThemes: page.feedbackThemes.map((row) => this.toListItem(row)),
          totalRecords: tabCounts[tab],
          tabCounts,
          ratingCounts,
        };
      },
    );
  }

  async getFeedbackTheme(params: {
    companyId: string;
    publicId: string;
  }): Promise<Schemas.GetFeedbackThemeApiResponse> {
    return await withTenant(
      this.db,
      params.companyId,
      async (tx): Promise<Schemas.GetFeedbackThemeApiResponse> => {
        const found = await this.dal.getFeedbackTheme(tx, { ...params, isForUpdate: false });
        if (!found.isSuccess || !found.feedbackTheme) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const detail = await this.toDetail(tx, params.companyId, found.feedbackTheme);
        if (!detail) return { isSuccess: false, message: "Feedback theme notes didn't load" };
        return {
          isSuccess: true,
          message: "Feedback theme fetched successfully",
          feedbackTheme: detail,
        };
      },
    );
  }

  // DEV_NOTE: Open → Resolved (unknown → 404; not Open → failure NotOpen, 409, nothing written); its item → Fixed
  async resolveFeedbackTheme(params: {
    companyId: string;
    publicId: string;
    adminId: string;
    actor: Schemas.AuditActor;
  }): Promise<Schemas.WithOutboxIds<Schemas.UpdateFeedbackThemeApiResponse>> {
    return await this.close(params, {
      status: Schemas.FeedbackThemeStatusIntEnum.Resolved,
      auditAction: Schemas.AuditEntityActionEnum.Resolved,
      issueStatus: Schemas.QualityIssueStatusIntEnum.Fixed,
      logAction: Schemas.LogAction.ResolveFeedbackTheme,
    });
  }

  // DEV_NOTE: Open → Dismissed, likewise; its item → Dismissed
  async dismissFeedbackTheme(params: {
    companyId: string;
    publicId: string;
    adminId: string;
    actor: Schemas.AuditActor;
  }): Promise<Schemas.WithOutboxIds<Schemas.UpdateFeedbackThemeApiResponse>> {
    return await this.close(params, {
      status: Schemas.FeedbackThemeStatusIntEnum.Dismissed,
      auditAction: Schemas.AuditEntityActionEnum.Dismissed,
      issueStatus: Schemas.QualityIssueStatusIntEnum.Dismissed,
      logAction: Schemas.LogAction.DismissFeedbackTheme,
    });
  }

  private async close(
    params: { companyId: string; publicId: string; adminId: string; actor: Schemas.AuditActor },
    move: {
      status: Schemas.CloseFeedbackThemeDALRequest["status"];
      auditAction: Schemas.AuditEntityActionFor<Schemas.AuditEntityTypeEnum.FeedbackTheme>;
      issueStatus: Schemas.QualityIssueCloseStatus;
      logAction: Schemas.LogAction;
    },
  ): Promise<Schemas.WithOutboxIds<Schemas.UpdateFeedbackThemeApiResponse>> {
    const { companyId } = params;
    const result: Schemas.WithOutboxIds<Schemas.UpdateFeedbackThemeApiResponse> = await withTenant(
      this.db,
      companyId,
      async (tx): Promise<Schemas.WithOutboxIds<Schemas.UpdateFeedbackThemeApiResponse>> => {
        const found = await this.dal.getFeedbackTheme(tx, {
          companyId,
          publicId: params.publicId,
          isForUpdate: true,
        });
        if (!found.isSuccess || !found.feedbackTheme) {
          return { isSuccess: false, message: found.message, isNotFound: found.isNotFound };
        }
        const theme = found.feedbackTheme;
        if (theme.status !== Schemas.FeedbackThemeStatusIntEnum.Open) {
          return {
            isSuccess: false,
            message: "Only an open theme can change",
            failure: Schemas.FeedbackThemeUpdateFailureEnum.NotOpen,
          };
        }

        const closed = await this.dal.closeFeedbackTheme(tx, {
          companyId,
          id: theme.id,
          status: move.status,
        });
        if (!closed.isSuccess) {
          throw new TenantRollbackError(closed.message ?? "Feedback theme not closed");
        }
        const auditOutboxId = await recordAuditOrRollback(tx, {
          companyId,
          actor: params.actor,
          entityType: Schemas.AuditEntityTypeEnum.FeedbackTheme,
          entityAction: move.auditAction,
          entity: theme,
          label: theme.label,
        });
        const item = await FeedbackThemeQualityProvider.closeForTheme(tx, {
          companyId,
          feedbackThemeId: theme.id,
          status: move.issueStatus,
          adminId: params.adminId,
          actor: params.actor,
        });
        if (!item.isSuccess) {
          throw new TenantRollbackError(item.message ?? "Quality item not closed");
        }

        const readBack = await this.dal.getFeedbackTheme(tx, {
          companyId,
          publicId: params.publicId,
          isForUpdate: false,
        });
        if (!readBack.isSuccess || !readBack.feedbackTheme) {
          throw new TenantRollbackError(readBack.message ?? "Feedback theme didn't load");
        }
        const detail = await this.toDetail(tx, companyId, readBack.feedbackTheme);
        if (!detail) throw new TenantRollbackError("Feedback theme notes didn't load");
        return {
          isSuccess: true,
          message: "Feedback theme updated successfully",
          feedbackTheme: detail,
          outboxIds: [auditOutboxId, ...(item.outboxId ? [item.outboxId] : [])],
        };
      },
    );
    if (!result.isSuccess && result.failure) {
      AppLogger.warn({
        category: Schemas.LogCategory.Repo,
        action: move.logAction,
        message: result.message ?? "Feedback theme not closed",
        metadata: { companyId, publicId: params.publicId, failure: result.failure },
      });
    }
    return result;
  }

  // DEV_NOTE: The theme with its newest notes; null when the notes didn't load
  private async toDetail(
    tx: Tx,
    companyId: string,
    row: Schemas.FeedbackThemeRow,
  ): Promise<Schemas.FeedbackThemeDetail | null> {
    const notes = await this.dal.getFeedbackThemeNotes(tx, {
      companyId,
      themeId: row.id,
      limit: Schemas.FEEDBACK_THEME_NOTES_MAX,
    });
    if (!notes.isSuccess || !notes.notes) return null;
    return {
      ...this.toListItem(row),
      notes: notes.notes.map((note) => ({
        publicId: note.publicId,
        summary: note.summary,
        conversationPublicId: note.conversationPublicId,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  }
}

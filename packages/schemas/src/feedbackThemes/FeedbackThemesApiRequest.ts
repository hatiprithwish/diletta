import { z } from "zod";
import { ZPageApiRequest } from "../common";
import {
  ZFeedbackThemeListTab,
  ZFeedbackThemeRatingFilter,
  ZFeedbackThemeSortColumn,
} from "./FeedbackThemesCommon";

// DEV_NOTE: GET /dashboard/feedback-themes (M7-10). Notes keep coming, so themes are paged. tab absent = Open, rating
// absent = Disliked.
export const ZGetFeedbackThemesApiRequest = ZPageApiRequest.extend({
  tab: ZFeedbackThemeListTab.optional(),
  rating: ZFeedbackThemeRatingFilter.optional(),
  sortColumn: ZFeedbackThemeSortColumn.nullable().optional(),
});
export type GetFeedbackThemesApiRequest = z.infer<typeof ZGetFeedbackThemesApiRequest>;

// DEV_NOTE: The User feedback view's URL search (apps/web validateSearch); an unknown value falls back to the default
// instead of failing the page
export const ZFeedbackThemesPageSearch = z.object({
  rating: ZFeedbackThemeRatingFilter.optional().catch(undefined),
  tab: ZFeedbackThemeListTab.optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
});
export type FeedbackThemesPageSearch = z.infer<typeof ZFeedbackThemesPageSearch>;

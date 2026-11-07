import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import { QUERY_KEY_ROOTS, invalidateClosedThemeViews } from "../../-invalidation";

// DEV_NOTE: Quality › User feedback (M7-10): the themes list (one query per thumb + tab + page), one theme with its
// notes, and Resolve / Dismiss. keys.all() covers them all. A write sets the detail (setQueryData), refetches the lists,
// and refreshes the Quality views since the theme's item closed with it.
export class FeedbackThemesQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.feedbackThemes,
    lists: () => [...FeedbackThemesQueries.keys.all(), "list"] as const,
    list: (search: Schemas.FeedbackThemesPageSearch) =>
      [...FeedbackThemesQueries.keys.lists(), search] as const,
    details: () => [...FeedbackThemesQueries.keys.all(), "detail"] as const,
    detail: (publicId: string) => [...FeedbackThemesQueries.keys.details(), publicId] as const,
  };

  static list(search: Schemas.FeedbackThemesPageSearch, getToken: Parameters<typeof apiClient>[1]) {
    const params = new URLSearchParams();
    if (search.rating) params.set("rating", search.rating);
    if (search.tab) params.set("tab", search.tab);
    params.set("pageNo", String(search.page ?? 1));
    params.set("pageSize", String(Schemas.FEEDBACK_THEMES_PAGE_SIZE));
    return queryOptions({
      queryKey: FeedbackThemesQueries.keys.list(search),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetFeedbackThemesApiResponse>(
          `/dashboard/feedback-themes?${params.toString()}`,
          getToken,
          { signal },
        ),
      // DEV_NOTE: The rows stay on screen while the next page, tab or thumb loads
      placeholderData: keepPreviousData,
    });
  }

  static detail(publicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: FeedbackThemesQueries.keys.detail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetFeedbackThemeApiResponse>(
          `/dashboard/feedback-themes/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useFeedbackThemes(search: Schemas.FeedbackThemesPageSearch) {
  const { getToken } = useAuth();
  return useQuery(FeedbackThemesQueries.list(search, getToken));
}

export function useFeedbackTheme(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(FeedbackThemesQueries.detail(publicId, getToken));
}

export enum FeedbackThemeCloseEnum {
  Resolve = "resolve",
  Dismiss = "dismiss",
}

const CLOSE_TOAST: Record<FeedbackThemeCloseEnum, string> = {
  [FeedbackThemeCloseEnum.Resolve]: "Marked resolved.",
  [FeedbackThemeCloseEnum.Dismiss]: "Theme dismissed.",
};

function applyWrite(
  queryClient: QueryClient,
  publicId: string,
  response: Schemas.UpdateFeedbackThemeApiResponse,
) {
  if (response.feedbackTheme) {
    queryClient.setQueryData<Schemas.GetFeedbackThemeApiResponse>(
      FeedbackThemesQueries.keys.detail(publicId),
      (previous) => ({ ...previous, isSuccess: true, feedbackTheme: response.feedbackTheme }),
    );
  } else {
    void queryClient.invalidateQueries({ queryKey: FeedbackThemesQueries.keys.detail(publicId) });
  }
  void queryClient.invalidateQueries({ queryKey: FeedbackThemesQueries.keys.lists() });
  invalidateClosedThemeViews(queryClient);
}

// DEV_NOTE: Mark resolved / Dismiss. A 409 means someone closed it first: the theme refetches and the toast says so.
export function useCloseFeedbackTheme(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (close: FeedbackThemeCloseEnum) =>
      apiClient<Schemas.UpdateFeedbackThemeApiResponse>(
        `/dashboard/feedback-themes/${encodeURIComponent(publicId)}/${close}`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response, close) => {
      applyWrite(queryClient, publicId, response);
      toast.success(CLOSE_TOAST[close]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({
          queryKey: FeedbackThemesQueries.keys.detail(publicId),
        });
        void queryClient.invalidateQueries({ queryKey: FeedbackThemesQueries.keys.lists() });
        toast.error("This theme was already closed. Nothing changed.");
        return;
      }
      toast.error("The theme wasn't closed. Nothing changed, try again.");
    },
  });
}

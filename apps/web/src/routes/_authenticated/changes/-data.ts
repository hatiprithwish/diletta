import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import { ConversationsQueries } from "../conversations/-data";
import { OverviewQueries } from "../overview/-data";

const REQUESTERS_STALE_MS = 5 * 60_000;

// DEV_NOTE: The page's filters as the API reads them (botId stays absent: no bot filter in the UI, DESIGN.md §6)
function filterParams(search: Schemas.ChangesPageSearch): URLSearchParams {
  const params = new URLSearchParams();
  if (search.tab) params.set("tab", search.tab);
  if (search.requesterId) params.set("requesterId", search.requesterId);
  return params;
}

// DEV_NOTE: Changes (M4-4 detail; M4-5 the list, the Requested by choices, the sidebar's needs-a-person count and Mark
// resolved). One list query per filter + page, one detail per change, the requesters apart (they don't change with the
// page or tab); keys.all() covers them all. A resolve changes the detail (setQueryData),
// the lists' rows and counts, and the count (both invalidated).
export class ChangesQueries {
  static keys = {
    all: () => ["changes"] as const,
    lists: () => [...ChangesQueries.keys.all(), "list"] as const,
    list: (search: Schemas.ChangesPageSearch) => [...ChangesQueries.keys.lists(), search] as const,
    details: () => [...ChangesQueries.keys.all(), "detail"] as const,
    detail: (publicId: string) => [...ChangesQueries.keys.details(), publicId] as const,
    needsHumanCount: () => [...ChangesQueries.keys.all(), "needs-human-count"] as const,
    requesters: (requesterId: string | null) =>
      [...ChangesQueries.keys.all(), "requesters", requesterId] as const,
  };

  static list(search: Schemas.ChangesPageSearch, getToken: Parameters<typeof apiClient>[1]) {
    const params = filterParams(search);
    params.set("pageNo", String(search.page ?? 1));
    params.set("pageSize", String(Schemas.CHANGES_PAGE_SIZE));
    return queryOptions({
      queryKey: ChangesQueries.keys.list(search),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChangeRequestsApiResponse>(
          `/dashboard/change-requests?${params.toString()}`,
          getToken,
          { signal },
        ),
      // DEV_NOTE: The rows stay on screen while the next page or filter loads
      placeholderData: keepPreviousData,
    });
  }

  static detail(publicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: ChangesQueries.keys.detail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChangeRequestApiResponse>(
          `/dashboard/change-requests/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }

  // DEV_NOTE: The Requested by choices, with the one the URL picked. They change only when a new user's first change
  // comes in, so a page or tab click doesn't ask again for a while (REQUESTERS_STALE_MS).
  static requesters(requesterId: string | null, getToken: Parameters<typeof apiClient>[1]) {
    const params = new URLSearchParams();
    if (requesterId) params.set("requesterId", requesterId);
    const query = params.toString();
    return queryOptions({
      queryKey: ChangesQueries.keys.requesters(requesterId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChangeRequestRequestersApiResponse>(
          `/dashboard/change-requests/requesters${query ? `?${query}` : ""}`,
          getToken,
          { signal },
        ),
      staleTime: REQUESTERS_STALE_MS,
      placeholderData: keepPreviousData,
    });
  }

  static needsHumanCount(getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: ChangesQueries.keys.needsHumanCount(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChangeRequestsNeedsHumanCountApiResponse>(
          "/dashboard/change-requests/needs-human-count",
          getToken,
          { signal },
        ),
    });
  }
}

export function useChanges(search: Schemas.ChangesPageSearch) {
  const { getToken } = useAuth();
  return useQuery(ChangesQueries.list(search, getToken));
}

export function useChangeRequesters(requesterId: string | null) {
  const { getToken } = useAuth();
  return useQuery(ChangesQueries.requesters(requesterId, getToken));
}

export function useChange(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(ChangesQueries.detail(publicId, getToken));
}

// DEV_NOTE: The sidebar's Changes badge (DESIGN.md §4)
export function useChangesNeedsHumanCount() {
  const { getToken } = useAuth();
  return useQuery(ChangesQueries.needsHumanCount(getToken));
}

// DEV_NOTE: Marks a change that needs a person resolved. The detail shows the answer at once; the lists, the badge,
// Overview's and Conversations' Needs attention refetch (they counted it). A 409 means someone resolved it first (or
// it no longer needs a person): the detail refetches to show where it stands.
export function useResolveChange(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const refreshCounts = () => {
    void queryClient.invalidateQueries({ queryKey: ChangesQueries.keys.lists() });
    void queryClient.invalidateQueries({ queryKey: ChangesQueries.keys.needsHumanCount() });
    void queryClient.invalidateQueries({ queryKey: OverviewQueries.keys.all() });
    void queryClient.invalidateQueries({ queryKey: ConversationsQueries.keys.all() });
  };
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.ResolveChangeRequestApiResponse>(
        `/dashboard/change-requests/${encodeURIComponent(publicId)}/resolve`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response) => {
      queryClient.setQueryData<Schemas.GetChangeRequestApiResponse>(
        ChangesQueries.keys.detail(publicId),
        (previous) =>
          response.changeRequest
            ? { ...previous, isSuccess: true, changeRequest: response.changeRequest }
            : previous,
      );
      refreshCounts();
      toast.success("Marked resolved.");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: ChangesQueries.keys.detail(publicId) });
        refreshCounts();
        toast.error("This change doesn't need a person any more. Nothing changed.");
        return;
      }
      toast.error("The change wasn't marked resolved. Nothing changed, try again.");
    },
  });
}

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
import {
  QUERY_KEY_ROOTS,
  invalidateOpenIssueViews,
  invalidateTestCaseViews,
} from "../-invalidation";

// DEV_NOTE: The Quality page (M4-6): the inbox list, one issue, the sidebar's open count, and the admin's work on an
// issue (triage, Mark fixed, Dismiss, Create test). One list query per tab + page, one detail per issue; keys.all()
// covers them all. A write changes the detail (setQueryData) and the lists' rows and counts (invalidated).
export class QualityQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.quality,
    lists: () => [...QualityQueries.keys.all(), "list"] as const,
    list: (search: Schemas.QualityPageSearch) => [...QualityQueries.keys.lists(), search] as const,
    details: () => [...QualityQueries.keys.all(), "detail"] as const,
    detail: (publicId: string) => [...QualityQueries.keys.details(), publicId] as const,
    openCount: () => [...QualityQueries.keys.all(), "open-count"] as const,
  };

  static list(search: Schemas.QualityPageSearch, getToken: Parameters<typeof apiClient>[1]) {
    const params = new URLSearchParams();
    if (search.tab) params.set("tab", search.tab);
    params.set("pageNo", String(search.page ?? 1));
    params.set("pageSize", String(Schemas.QUALITY_PAGE_SIZE));
    return queryOptions({
      queryKey: QualityQueries.keys.list(search),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetQualityIssuesApiResponse>(
          `/dashboard/quality-issues?${params.toString()}`,
          getToken,
          { signal },
        ),
      // DEV_NOTE: The rows stay on screen while the next page or tab loads
      placeholderData: keepPreviousData,
    });
  }

  static detail(publicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: QualityQueries.keys.detail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetQualityIssueApiResponse>(
          `/dashboard/quality-issues/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }

  static openCount(getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: QualityQueries.keys.openCount(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetQualityIssuesOpenCountApiResponse>(
          "/dashboard/quality-issues/open-count",
          getToken,
          { signal },
        ),
    });
  }
}

export function useQualityIssues(search: Schemas.QualityPageSearch) {
  const { getToken } = useAuth();
  return useQuery(QualityQueries.list(search, getToken));
}

export function useQualityIssue(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(QualityQueries.detail(publicId, getToken));
}

// DEV_NOTE: The sidebar's Quality badge (DESIGN.md §4)
export function useQualityOpenCount() {
  const { getToken } = useAuth();
  return useQuery(QualityQueries.openCount(getToken));
}

// DEV_NOTE: After a write: the detail shows the answer at once; the lists refetch. A write that closes the issue also
// changes the open count, Overview's Needs attention and the Conversations' Needs attention tab (they count open
// issues).
function applyWrite(
  queryClient: QueryClient,
  publicId: string,
  response: Schemas.UpdateQualityIssueApiResponse,
  isClosing: boolean,
) {
  if (response.qualityIssue) {
    queryClient.setQueryData<Schemas.GetQualityIssueApiResponse>(
      QualityQueries.keys.detail(publicId),
      (previous) => ({ ...previous, isSuccess: true, qualityIssue: response.qualityIssue }),
    );
  } else {
    void queryClient.invalidateQueries({ queryKey: QualityQueries.keys.detail(publicId) });
  }
  void queryClient.invalidateQueries({ queryKey: QualityQueries.keys.lists() });
  if (isClosing) invalidateOpenIssueViews(queryClient);
}

// DEV_NOTE: Why a write was refused (409), in the dashboard's words (DESIGN.md §8)
const UPDATE_FAILURE_TEXT: Record<Schemas.QualityIssueUpdateFailureEnum, string> = {
  [Schemas.QualityIssueUpdateFailureEnum.NotOpen]:
    "This issue was already closed. Nothing changed.",
  [Schemas.QualityIssueUpdateFailureEnum.ChatbotNotFound]:
    "This conversation's chatbot was removed, so the test can't be saved. Nothing changed.",
  [Schemas.QualityIssueUpdateFailureEnum.NoConversation]:
    "This issue is about the whole chatbot, not one conversation, so it can't become a test. Nothing changed.",
};

// DEV_NOTE: A 409: someone else closed or converted the issue first (or, on save, its chatbot is gone). The detail and
// every view counting open issues refetch to show where it stands. true = handled.
function onRefused(queryClient: QueryClient, publicId: string, error: Error): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  void queryClient.invalidateQueries({ queryKey: QualityQueries.keys.detail(publicId) });
  invalidateOpenIssueViews(queryClient);
  const failure = (error.body as Schemas.UpdateQualityIssueApiResponse).failure;
  toast.error(UPDATE_FAILURE_TEXT[failure ?? Schemas.QualityIssueUpdateFailureEnum.NotOpen]);
  return true;
}

// DEV_NOTE: Sets the issue type or the note (each saved on its own)
export function useTriageQualityIssue(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.TriageQualityIssueApiRequest) =>
      apiClient<Schemas.UpdateQualityIssueApiResponse>(
        `/dashboard/quality-issues/${encodeURIComponent(publicId)}`,
        getToken,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => applyWrite(queryClient, publicId, response, false),
    onError: (error) => {
      if (onRefused(queryClient, publicId, error)) return;
      toast.error("The issue wasn't updated. Nothing changed, try again.");
    },
  });
}

const CLOSE_PATH: Record<Schemas.QualityIssueCloseStatus, string> = {
  [Schemas.QualityIssueStatusIntEnum.Fixed]: "fix",
  [Schemas.QualityIssueStatusIntEnum.Dismissed]: "dismiss",
};

const CLOSE_TOAST: Record<Schemas.QualityIssueCloseStatus, string> = {
  [Schemas.QualityIssueStatusIntEnum.Fixed]: "Marked fixed.",
  [Schemas.QualityIssueStatusIntEnum.Dismissed]: "Issue dismissed.",
};

// DEV_NOTE: Mark fixed / Dismiss
export function useCloseQualityIssue(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: Schemas.QualityIssueCloseStatus) =>
      apiClient<Schemas.UpdateQualityIssueApiResponse>(
        `/dashboard/quality-issues/${encodeURIComponent(publicId)}/${CLOSE_PATH[status]}`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response, status) => {
      applyWrite(queryClient, publicId, response, true);
      toast.success(CLOSE_TOAST[status]);
    },
    onError: (error) => {
      if (onRefused(queryClient, publicId, error)) return;
      toast.error("The issue wasn't closed. Nothing changed, try again.");
    },
  });
}

// DEV_NOTE: Why there is no draft, in the dashboard's words (DESIGN.md §8)
const DRAFT_FAILURE_TEXT: Record<Schemas.QualityTestDraftFailureEnum, string> = {
  [Schemas.QualityTestDraftFailureEnum.NotOpen]: "This issue was already closed. Nothing changed.",
  [Schemas.QualityTestDraftFailureEnum.NoConversation]:
    "This chat has no question left to test. Its content may have been deleted.",
  [Schemas.QualityTestDraftFailureEnum.NoPublishedConfig]:
    "Publish this chatbot before creating tests from its chats.",
  [Schemas.QualityTestDraftFailureEnum.ModelUnavailable]:
    "The model is unavailable right now. Check your model key and budget, then try again.",
  [Schemas.QualityTestDraftFailureEnum.RewriteFailed]:
    "The chat couldn't be rewritten this time. Try again.",
};

// DEV_NOTE: Create test, step 1: the rewritten chat to review (nothing is saved). The caller awaits it (mutateAsync)
// to open the review with the draft.
export function useDraftQualityTest(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.DraftQualityTestApiResponse>(
        `/dashboard/quality-issues/${encodeURIComponent(publicId)}/test-draft`,
        getToken,
        { method: "POST" },
      ),
    onError: (error) => {
      const failure =
        error instanceof ApiError
          ? (error.body as Schemas.DraftQualityTestApiResponse).failure
          : undefined;
      if (failure === Schemas.QualityTestDraftFailureEnum.NotOpen) {
        onRefused(queryClient, publicId, error);
        return;
      }
      toast.error(failure ? DRAFT_FAILURE_TEXT[failure] : "The test draft didn't load. Try again.");
    },
  });
}

// DEV_NOTE: Create test, step 2: the reviewed draft saved as a test, the issue converted. The review dialog awaits it
// (mutateAsync) and closes on success.
export function useConvertQualityIssue(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: Schemas.ConvertQualityIssueApiRequest) =>
      apiClient<Schemas.UpdateQualityIssueApiResponse>(
        `/dashboard/quality-issues/${encodeURIComponent(publicId)}/convert`,
        getToken,
        { method: "POST", body: JSON.stringify(draft) },
      ),
    onSuccess: (response) => {
      applyWrite(queryClient, publicId, response, true);
      invalidateTestCaseViews(queryClient);
      toast.success("Test saved.");
    },
    onError: (error) => {
      if (onRefused(queryClient, publicId, error)) return;
      toast.error("The test wasn't saved. Nothing changed, try again.");
    },
  });
}

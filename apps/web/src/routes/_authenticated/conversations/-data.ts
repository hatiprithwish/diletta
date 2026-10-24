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
import { apiClient } from "@/providers/apiClient";
import { OverviewQueries } from "../overview/-data";
import { QualityQueries } from "../quality/-data";
import Utilities from "@/utils";

// DEV_NOTE: The page's filters as the API reads them (botId stays absent: no bot filter in the UI, DESIGN.md §6)
function filterParams(search: Schemas.ConversationsPageSearch): URLSearchParams {
  const params = new URLSearchParams();
  if (search.tab) params.set("tab", search.tab);
  if (search.outcome) params.set("outcome", search.outcome);
  if (search.configId) params.set("configId", search.configId);
  return params;
}

// DEV_NOTE: The Conversations page (M4-4). One list query per filter + page, one detail per conversation; keys.all()
// covers both. A flag changes the detail (setQueryData) and the Needs attention counts (lists invalidated).
export class ConversationsQueries {
  static keys = {
    all: () => ["conversations"] as const,
    lists: () => [...ConversationsQueries.keys.all(), "list"] as const,
    list: (search: Schemas.ConversationsPageSearch) =>
      [...ConversationsQueries.keys.lists(), search] as const,
    details: () => [...ConversationsQueries.keys.all(), "detail"] as const,
    detail: (publicId: string) => [...ConversationsQueries.keys.details(), publicId] as const,
  };

  static list(search: Schemas.ConversationsPageSearch, getToken: Parameters<typeof apiClient>[1]) {
    const params = filterParams(search);
    params.set("pageNo", String(search.page ?? 1));
    params.set("pageSize", String(Schemas.CONVERSATIONS_PAGE_SIZE));
    return queryOptions({
      queryKey: ConversationsQueries.keys.list(search),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetConversationsApiResponse>(
          `/dashboard/conversations?${params.toString()}`,
          getToken,
          { signal },
        ),
      // DEV_NOTE: The rows stay on screen while the next page or filter loads
      placeholderData: keepPreviousData,
    });
  }

  static detail(publicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: ConversationsQueries.keys.detail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetConversationApiResponse>(
          `/dashboard/conversations/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useConversations(search: Schemas.ConversationsPageSearch) {
  const { getToken } = useAuth();
  return useQuery(ConversationsQueries.list(search, getToken));
}

export function useConversation(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(ConversationsQueries.detail(publicId, getToken));
}

// DEV_NOTE: Flags the conversation into the quality inbox. The detail shows it flagged at once; the lists and Overview
// refetch (their Needs attention counts it now).
export function useFlagConversation(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.FlagConversationApiResponse>(
        `/dashboard/conversations/${encodeURIComponent(publicId)}/flag`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.setQueryData<Schemas.GetConversationApiResponse>(
        ConversationsQueries.keys.detail(publicId),
        (previous) =>
          previous?.conversation
            ? { ...previous, conversation: { ...previous.conversation, isFlagged: true } }
            : previous,
      );
      void queryClient.invalidateQueries({ queryKey: ConversationsQueries.keys.lists() });
      // DEV_NOTE: Overview's Needs attention, the Quality list and its badge count open issues of every source, the
      // new one too
      void queryClient.invalidateQueries({ queryKey: OverviewQueries.keys.all() });
      void queryClient.invalidateQueries({ queryKey: QualityQueries.keys.all() });
      toast.success("Conversation flagged. It's in the Quality inbox.");
    },
    onError: () => {
      toast.error("The conversation wasn't flagged. Nothing changed, try again.");
    },
  });
}

const CSV_HEADER = [
  "Conversation ID",
  "User",
  "First message",
  "Outcome",
  "Turns",
  "Chatbot",
  "Config",
  "Rating",
  "Started",
  "Last activity",
];

// DEV_NOTE: Downloads every conversation under the current filters (no page) as a CSV, newest first, up to
// CONVERSATIONS_EXPORT_MAX_ROWS. It reads, but runs on a click, so it's a mutation.
export function useExportConversations() {
  const { getToken } = useAuth();
  return useMutation({
    mutationFn: async (search: Schemas.ConversationsPageSearch) => {
      const response = await apiClient<Schemas.ExportConversationsApiResponse>(
        `/dashboard/conversations/export?${filterParams(search).toString()}`,
        getToken,
      );
      const rows = (response.conversations ?? []).map((conversation) => [
        conversation.publicId,
        conversation.userName ?? "",
        conversation.title ?? "",
        conversation.outcomeLabel,
        String(conversation.turnCount),
        conversation.chatbotName ?? "",
        conversation.configVersion === null ? "" : `v${conversation.configVersion}`,
        conversation.ratingLabel ?? "",
        conversation.createdAt,
        conversation.lastActivityAt,
      ]);
      Utilities.downloadFile(
        `conversations-${new Date().toISOString().slice(0, 10)}.csv`,
        // DEV_NOTE: The BOM makes Excel read the file as UTF-8 (titles in any script); other apps ignore it
        `\uFEFF${Utilities.toCsv([CSV_HEADER, ...rows])}`,
        "text/csv;charset=utf-8",
      );
      return { count: rows.length, isTruncated: response.isTruncated ?? false };
    },
    onSuccess: ({ count, isTruncated }) => {
      toast.success(
        isTruncated
          ? `Exported the newest ${Utilities.formatCount(count)} conversations.`
          : `Exported ${Utilities.plural(count, "conversation")}.`,
      );
    },
    onError: () => {
      toast.error("The export didn't download. Try again.");
    },
  });
}

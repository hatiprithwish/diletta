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
import { BOTS_KEY_SEGMENTS, QUERY_KEY_ROOTS, invalidateLiveConfigViews } from "../../-invalidation";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: Settings › Bots (M4-10): the chatbots table, one chatbot's versions (paged, newest first) and one version, the
// draft editor's pickers, and Read-only mode. keys.all() covers them all; keys.versions(chatbot) covers a chatbot's list,
// count and every version of it. A version write sets its detail (setQueryData) and refreshes the chatbot's list and the
// table (its live version); a publish also refreshes the other pages that show the live config.
export class BotsQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.bots,
    rows: () => [...BotsQueries.keys.all(), "rows"] as const,
    options: () => [...BotsQueries.keys.all(), BOTS_KEY_SEGMENTS.options] as const,
    readOnly: () => [...BotsQueries.keys.all(), "read-only"] as const,
    versions: (chatbotPublicId: string) =>
      [...BotsQueries.keys.all(), "versions", chatbotPublicId] as const,
    versionList: (chatbotPublicId: string, page: number) =>
      [...BotsQueries.keys.versions(chatbotPublicId), "list", page] as const,
    versionCount: (chatbotPublicId: string) =>
      [...BotsQueries.keys.versions(chatbotPublicId), "count"] as const,
    version: (chatbotPublicId: string, publicId: string) =>
      [...BotsQueries.keys.versions(chatbotPublicId), "detail", publicId] as const,
  };

  static rows(getToken: GetToken) {
    return queryOptions({
      queryKey: BotsQueries.keys.rows(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChatbotSettingsRowsApiResponse>(
          "/dashboard/chatbots/settings",
          getToken,
          {
            signal,
          },
        ),
    });
  }

  static options(getToken: GetToken) {
    return queryOptions({
      queryKey: BotsQueries.keys.options(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChatbotConfigOptionsApiResponse>(
          "/dashboard/chatbots/config-options",
          getToken,
          { signal },
        ),
    });
  }

  static readOnly(getToken: GetToken) {
    return queryOptions({
      queryKey: BotsQueries.keys.readOnly(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetReadOnlyModeApiResponse>("/dashboard/settings/read-only", getToken, {
          signal,
        }),
    });
  }

  static versionList(chatbotPublicId: string, page: number, getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(Schemas.CHATBOT_CONFIG_VERSIONS_PAGE_SIZE),
    });
    return queryOptions({
      queryKey: BotsQueries.keys.versionList(chatbotPublicId, page),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChatbotConfigsApiResponse>(
          `${configsPath(chatbotPublicId)}?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }

  static versionCount(chatbotPublicId: string, getToken: GetToken) {
    return queryOptions({
      queryKey: BotsQueries.keys.versionCount(chatbotPublicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChatbotConfigsCountApiResponse>(
          `${configsPath(chatbotPublicId)}/count`,
          getToken,
          { signal },
        ),
    });
  }

  static version(chatbotPublicId: string, publicId: string, getToken: GetToken) {
    return queryOptions({
      queryKey: BotsQueries.keys.version(chatbotPublicId, publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChatbotConfigApiResponse>(
          `${configsPath(chatbotPublicId)}/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }
}

function configsPath(chatbotPublicId: string) {
  return `/dashboard/chatbots/${encodeURIComponent(chatbotPublicId)}/configs`;
}

export function useBotRows() {
  const { getToken } = useAuth();
  return useQuery(BotsQueries.rows(getToken));
}

export function useConfigOptions() {
  const { getToken } = useAuth();
  return useQuery(BotsQueries.options(getToken));
}

export function useReadOnlyMode() {
  const { getToken } = useAuth();
  return useQuery(BotsQueries.readOnly(getToken));
}

export function useBotVersions(chatbotPublicId: string, page: number) {
  const { getToken } = useAuth();
  return useQuery(BotsQueries.versionList(chatbotPublicId, page, getToken));
}

export function useBotVersionsCount(chatbotPublicId: string) {
  const { getToken } = useAuth();
  return useQuery(BotsQueries.versionCount(chatbotPublicId, getToken));
}

export function useBotVersion(chatbotPublicId: string, publicId: string) {
  const { getToken } = useAuth();
  return useQuery(BotsQueries.version(chatbotPublicId, publicId, getToken));
}

// DEV_NOTE: The refusal a draft write or publish answered (409 / 400 with its failure), for the editor to show; null for
// any other error
export function configRefusalOf(error: unknown): Schemas.ChatbotConfigWriteApiResponse | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as Schemas.ChatbotConfigWriteApiResponse;
  return body.failure ? body : null;
}

// DEV_NOTE: A version was written: its detail is set from the answer, the chatbot's list and count refetch, and so does
// the table (a publish changes its Live config)
function applyVersionWrite(
  queryClient: QueryClient,
  chatbotPublicId: string,
  response: Schemas.ChatbotConfigWriteApiResponse,
) {
  const { chatbotConfig } = response;
  if (chatbotConfig) {
    queryClient.setQueryData<Schemas.GetChatbotConfigApiResponse>(
      BotsQueries.keys.version(chatbotPublicId, chatbotConfig.publicId),
      { isSuccess: true, message: response.message, chatbotConfig },
    );
  }
  void queryClient.invalidateQueries({
    queryKey: [...BotsQueries.keys.versions(chatbotPublicId)],
    predicate: (query) => query.queryKey[3] !== "detail",
  });
  void queryClient.invalidateQueries({ queryKey: BotsQueries.keys.rows() });
}

// DEV_NOTE: Every version write's error toast: a refusal says why (the editor also shows it), a gone chatbot or version
// says so, anything else says nothing changed
function toastVersionError(error: unknown, fallback: string) {
  const refusal = configRefusalOf(error);
  if (refusal) {
    toast.error(`${refusal.message ?? fallback} Nothing changed.`);
    return;
  }
  if (error instanceof ApiError && error.status === 404) {
    toast.error("This chatbot or version isn't available. It may have been removed.");
    return;
  }
  toast.error(`${fallback} Nothing changed, try again.`);
}

// ─── Chatbots

export function useCreateBot() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.CreateChatbotApiRequest) =>
      apiClient<Schemas.CreateChatbotApiResponse>("/dashboard/chatbots", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BotsQueries.keys.rows() });
      toast.success("Bot created.");
    },
    onError: () => {
      toast.error("The bot wasn't created. Nothing changed, try again.");
    },
  });
}

// DEV_NOTE: Rename, or Pause / Resume
export function useUpdateBot(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateChatbotApiRequest) =>
      apiClient<Schemas.UpdateChatbotApiResponse>(
        `/dashboard/chatbots/${encodeURIComponent(publicId)}`,
        getToken,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (_response, body) => {
      void queryClient.invalidateQueries({ queryKey: BotsQueries.keys.rows() });
      if (body.chatbot.status === Schemas.ChatbotStatusIntEnum.Paused) {
        toast.success("Bot paused. It stops answering from the next message.");
      } else if (body.chatbot.status === Schemas.ChatbotStatusIntEnum.Active) {
        toast.success("Bot resumed.");
      } else {
        toast.success("Bot renamed.");
      }
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: BotsQueries.keys.rows() });
        toast.error("This bot isn't available. It may have been removed.");
        return;
      }
      toast.error("The bot wasn't saved. Nothing changed, try again.");
    },
  });
}

export function useMakeDefaultBot() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publicId: string) =>
      apiClient<Schemas.SetDefaultChatbotApiResponse>(
        `/dashboard/chatbots/${encodeURIComponent(publicId)}/default`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BotsQueries.keys.rows() });
      toast.success("Default bot changed. The widget loads it when the page names no bot.");
    },
    onError: () => {
      toast.error("The default bot didn't change. Try again.");
    },
  });
}

// ─── Versions

// DEV_NOTE: A new draft from the editor's body. The editor awaits it (mutateAsync) to open the new version.
export function useCreateDraft(chatbotPublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.SaveChatbotConfigApiRequest) =>
      apiClient<Schemas.ChatbotConfigWriteApiResponse>(configsPath(chatbotPublicId), getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      applyVersionWrite(queryClient, chatbotPublicId, response);
      toast.success("Draft saved.");
    },
    onError: (error) => toastVersionError(error, "The draft wasn't saved."),
  });
}

// DEV_NOTE: Rollback as copy (and Open draft from the live version): awaited (mutateAsync) to open the new draft
export function useCopyVersion(chatbotPublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publicId: string) =>
      apiClient<Schemas.ChatbotConfigWriteApiResponse>(
        `${configsPath(chatbotPublicId)}/${encodeURIComponent(publicId)}/copy`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response) => {
      applyVersionWrite(queryClient, chatbotPublicId, response);
      toast.success(`Copied into a new draft, v${response.chatbotConfig?.configVersion ?? ""}.`);
    },
    onError: (error) => toastVersionError(error, "The version wasn't copied."),
  });
}

export function useSaveDraft(chatbotPublicId: string, publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.SaveChatbotConfigApiRequest) =>
      apiClient<Schemas.ChatbotConfigWriteApiResponse>(
        `${configsPath(chatbotPublicId)}/${encodeURIComponent(publicId)}`,
        getToken,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      applyVersionWrite(queryClient, chatbotPublicId, response);
      toast.success("Draft saved.");
    },
    onError: (error) => toastVersionError(error, "The draft wasn't saved."),
  });
}

export function useDiscardDraft(chatbotPublicId: string, publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.ChatbotConfigWriteApiResponse>(
        `${configsPath(chatbotPublicId)}/${encodeURIComponent(publicId)}/discard`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response) => {
      applyVersionWrite(queryClient, chatbotPublicId, response);
      toast.success("Draft discarded. The live version didn't change.");
    },
    onError: (error) => toastVersionError(error, "The draft wasn't discarded."),
  });
}

export function usePublishVersion(chatbotPublicId: string, publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.ChatbotConfigWriteApiResponse>(
        `${configsPath(chatbotPublicId)}/${encodeURIComponent(publicId)}/publish`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response) => {
      applyVersionWrite(queryClient, chatbotPublicId, response);
      invalidateLiveConfigViews(queryClient);
      toast.success(
        `v${response.chatbotConfig?.configVersion ?? ""} is live. The assistant uses it from the next message.`,
      );
    },
    onError: (error) => toastVersionError(error, "The version wasn't published."),
  });
}

// ─── Read-only mode

export function useSetReadOnlyMode() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateReadOnlyModeApiRequest) =>
      apiClient<Schemas.UpdateReadOnlyModeApiResponse>("/dashboard/settings/read-only", getToken, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      queryClient.setQueryData<Schemas.GetReadOnlyModeApiResponse>(BotsQueries.keys.readOnly(), {
        isSuccess: true,
        message: response.message,
        readOnlyMode: response.readOnlyMode,
      });
      toast.success(
        response.readOnlyMode?.isReadOnly
          ? "Read-only mode is on. Changes to your data are blocked for every bot."
          : "Read-only mode is off. Approved changes can run again.",
      );
    },
    onError: () => {
      toast.error("Read-only mode didn't change. Try again.");
    },
  });
}

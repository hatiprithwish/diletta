import { useCallback, useEffect, useState } from "react";
import * as Schemas from "@app/schemas";
import { useLatest } from "@/hooks/useLatest";
import { fetchConversations, fetchPastConversation } from "@/lib/historyApi";

// DEV_NOTE: Your chats: read from page 1 each time the screen opens (a chat may have ended or started since), with a
// fresh token from the host for every read, never stored. Reopened, it shows the rows it read last until the new read
// lands. Show more appends the next page; a failed one keeps the rows already shown. Reads only.
export function useHistory(
  params: Omit<Schemas.WidgetAppProps, "getHostToken"> & {
    isActive: boolean;
  },
) {
  const { apiBase, chatbot, isActive } = params;
  const getTokenRef = useLatest(params.getToken);
  const [state, setState] = useState<Schemas.WidgetHistoryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const readPage = useCallback(
    async (pageNo: number, signal: AbortSignal) => {
      let token: string;
      try {
        token = await getTokenRef.current();
      } catch {
        return { status: "failed" } as const;
      }
      return await fetchConversations({ apiBase, chatbot, token, pageNo, signal });
    },
    [apiBase, chatbot, getTokenRef],
  );

  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController();
    void (async () => {
      const result = await readPage(1, controller.signal);
      if (controller.signal.aborted) return;
      setState(
        result.status === "ok"
          ? {
              status: "ready",
              items: result.data.conversations ?? [],
              totalRecords: result.data.totalRecords ?? 0,
              isLoadingMore: false,
              moreFailed: false,
            }
          : { status: "failed" },
      );
    })();
    return () => controller.abort();
  }, [isActive, attempt, readPage]);

  const loadMore = useCallback(() => {
    if (state.status !== "ready" || state.isLoadingMore) return;
    // DEV_NOTE: Pages are the server's size; the next page follows the rows read so far
    const pageNo = Math.floor(state.items.length / Schemas.WIDGET_HISTORY_PAGE_SIZE) + 1;
    setState({ ...state, isLoadingMore: true, moreFailed: false });
    void (async () => {
      const result = await readPage(pageNo, new AbortController().signal);
      setState((current) => {
        if (current.status !== "ready") return current;
        if (result.status !== "ok") return { ...current, isLoadingMore: false, moreFailed: true };
        const known = new Set(current.items.map((item) => item.publicId));
        const added = (result.data.conversations ?? []).filter((item) => !known.has(item.publicId));
        return {
          status: "ready",
          items: [...current.items, ...added],
          totalRecords: result.data.totalRecords ?? current.totalRecords,
          isLoadingMore: false,
          moreFailed: false,
        };
      });
    })();
  }, [readPage, state]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  return { state, loadMore, retry };
}

// DEV_NOTE: One chat that has ended, read back when its screen opens, with a fresh token. The state is kept with the
// chat it was read for, so another chat shows as loading until its own read lands.
export function usePastChat(
  params: Omit<Schemas.WidgetAppProps, "getHostToken"> & {
    publicId: string | null;
  },
) {
  const { apiBase, chatbot, publicId } = params;
  const getTokenRef = useLatest(params.getToken);
  const [read, setRead] = useState<{ publicId: string; state: Schemas.WidgetPastChatState } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!publicId) return;
    const controller = new AbortController();
    const settle = (state: Schemas.WidgetPastChatState) => {
      if (!controller.signal.aborted) setRead({ publicId, state });
    };
    void (async () => {
      let token: string;
      try {
        token = await getTokenRef.current();
      } catch {
        settle({ status: "failed" });
        return;
      }
      const result = await fetchPastConversation({
        apiBase,
        chatbot,
        token,
        publicId,
        signal: controller.signal,
      });
      settle(
        result.status === "ok"
          ? { status: "ready", conversation: result.data }
          : { status: result.status },
      );
    })();
    return () => controller.abort();
  }, [apiBase, chatbot, publicId, attempt, getTokenRef]);

  const state: Schemas.WidgetPastChatState =
    read && read.publicId === publicId ? read.state : { status: "loading" };
  const retry = useCallback(() => {
    setRead(null);
    setAttempt((value) => value + 1);
  }, []);
  return { state, retry };
}

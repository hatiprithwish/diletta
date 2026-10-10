import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import * as Schemas from "@app/schemas";
import { useWidgetStore, useWidgetStoreApi } from "@/store/WidgetStoreContext";
import { writeSavedConversation } from "@/lib/savedConversation";

// DEV_NOTE: The chat socket (GET /widget/ws, ADR 0001) through Think's client (useAgent + useAgentChat).
//
// When it opens: only for a first message, or when the panel opens on a saved conversation, so an idle visitor never
// creates a conversation. The token goes in Sec-WebSocket-Protocol (['diletta.v1', <jwt>]), fetched fresh from the
// host for every connect; never in the URL.
//
// A new conversation: the server names it in its `conversation` frame; the widget saves the id and reconnects with it
// once, before sending anything, so a later reconnect (network drop, reload) resumes it instead of starting another.
// The message that opened the socket waits in pendingText until the socket is ready.
//
// The DO's own frames (Schemas.ZWidgetServerMessage, parsed before use): unavailable / a refused send stop the
// pending request (the DO never answers it, so Think's client would wait forever) and drop or keep the unsent message;
// closed starts over; feedback settles a thumb.
//
// One socket per conversation id: the session using this hook is remounted when the id changes (ChatSession's key), so
// each socket is created with its final address. (partysocket reconnects its old socket, at its old address, when the
// address changes right after `enabled` turned on, so the address must never change under a live hook.)
//
// A refused upgrade can't be read by a browser (it sees a close before open), so failures are counted: after
// RESUME_FAILURES the saved conversation is dropped (closed or not the user's any more) and a new one starts; after
// UNAVAILABLE_FAILURES the widget shows its unavailable state.
const AGENT_NAME = "conversation";
const SOCKET_PATH = "widget/ws";
const RESUME_FAILURES = 2;
const UNAVAILABLE_FAILURES = 5;
const CLOSED_NOTICE =
  "This chat ended after a while without messages. Ask a new question any time.";
const FEEDBACK_NOT_SAVED_NOTICE = "Your feedback wasn't saved. Please try again.";

export function useConversation(params: {
  apiBase: string;
  chatbot: string | null;
  getToken: () => Promise<string>;
  savedKey: string | null;
}) {
  const { apiBase, chatbot, savedKey } = params;
  const storeApi = useWidgetStoreApi();
  const conversationPublicId = useWidgetStore((state) => state.conversationPublicId);
  const isSocketEnabled = useWidgetStore((state) => state.isSocketEnabled);
  const isOpen = useWidgetStore((state) => state.isOpen);
  const [isReady, setIsReady] = useState(false);

  const getTokenRef = useRef(params.getToken);
  useLayoutEffect(() => {
    getTokenRef.current = params.getToken;
  });
  const hasOpenedRef = useRef(false);
  const failuresRef = useRef(0);

  const setConversation = useCallback(
    (publicId: string | null) => {
      storeApi.getState().setConversation(publicId);
      if (savedKey) writeSavedConversation(savedKey, publicId);
    },
    [savedKey, storeApi],
  );

  const url = useMemo(() => new URL(apiBase), [apiBase]);
  const query = useMemo(() => {
    const entries: Record<string, string> = {};
    if (chatbot) entries.chatbot = chatbot;
    if (conversationPublicId) entries.conversation = conversationPublicId;
    return entries;
  }, [chatbot, conversationPublicId]);
  const protocols = useCallback(
    async () => [Schemas.WIDGET_SUBPROTOCOL, await getTokenRef.current()],
    [],
  );

  // DEV_NOTE: Read through a ref by the socket's frame handler, which is created before the chat helpers exist
  const chatRef = useRef<ReturnType<typeof useAgentChat> | null>(null);

  const handleFrame = useCallback(
    (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = Schemas.ZWidgetServerMessage.safeParse(json);
      if (!parsed.success) return;
      const frame = parsed.data;
      const store = storeApi.getState();
      const chat = chatRef.current;

      switch (frame.type) {
        case "conversation": {
          if (store.conversationPublicId !== frame.conversation.publicId) {
            setIsReady(false);
            setConversation(frame.conversation.publicId);
            return;
          }
          failuresRef.current = 0;
          const ratings = Object.fromEntries(
            frame.feedback.map((entry) => [entry.messageId, entry.rating]),
          );
          store.patch({ ratings, pendingRatings: {}, isUnavailable: false });
          setIsReady(true);
          return;
        }
        case "closed": {
          setIsReady(false);
          setConversation(null);
          chat?.setMessages([]);
          store.patch({
            isSocketEnabled: store.pendingText !== null,
            ratings: {},
            pendingRatings: {},
            notice: store.pendingText === null ? CLOSED_NOTICE : null,
          });
          return;
        }
        case "unavailable": {
          void chat?.stop();
          store.patch({ isUnavailable: true, notice: null });
          return;
        }
        case "error": {
          const isTurnPending = chat?.status === "submitted";
          if (isTurnPending && chat) {
            void chat.stop();
            const unsent = chat.messages.at(-1);
            if (unsent?.role === "user") {
              chat.setMessages(chat.messages.slice(0, -1));
              const text = unsent.parts
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
              store.patch({ draft: store.draft || text });
            }
          }
          store.patch({ notice: frame.message });
          return;
        }
        case "feedback": {
          const { [frame.messageId]: _settled, ...pendingRatings } = store.pendingRatings;
          if (frame.rating === null) {
            store.patch({ pendingRatings, notice: FEEDBACK_NOT_SAVED_NOTICE });
            return;
          }
          store.patch({
            pendingRatings,
            ratings: { ...store.ratings, [frame.messageId]: frame.rating },
          });
          return;
        }
      }
    },
    [setConversation, storeApi],
  );

  const handleOpen = useCallback(() => {
    hasOpenedRef.current = true;
  }, []);

  const handleClose = useCallback(() => {
    setIsReady(false);
    const wasOpen = hasOpenedRef.current;
    hasOpenedRef.current = false;
    if (wasOpen) return;

    failuresRef.current += 1;
    const store = storeApi.getState();
    if (failuresRef.current >= UNAVAILABLE_FAILURES) {
      failuresRef.current = 0;
      store.patch({ isSocketEnabled: false, isUnavailable: true });
      return;
    }
    if (failuresRef.current >= RESUME_FAILURES && store.conversationPublicId) {
      chatRef.current?.setMessages([]);
      setConversation(null);
    }
  }, [setConversation, storeApi]);

  const agent = useAgent({
    agent: AGENT_NAME,
    basePath: SOCKET_PATH,
    host: url.host,
    protocol: url.protocol === "https:" ? "wss" : "ws",
    query,
    protocols,
    enabled: isSocketEnabled,
    onMessage: handleFrame,
    onOpen: handleOpen,
    onClose: handleClose,
  });

  const chat = useAgentChat({
    agent,
    getInitialMessages: null,
    // DEV_NOTE: The DO reads only the newest message (the session is the history), so only that one is sent: a long
    // chat never outgrows the frame size cap
    prepareSendMessagesRequest: ({ messages }) => ({ body: { messages: messages.slice(-1) } }),
  });
  useLayoutEffect(() => {
    chatRef.current = chat;
  });

  // DEV_NOTE: Opening the panel on a saved conversation connects, so its history shows
  useEffect(() => {
    if (isOpen && conversationPublicId && !isSocketEnabled) {
      storeApi.getState().patch({ isSocketEnabled: true });
    }
  }, [isOpen, conversationPublicId, isSocketEnabled, storeApi]);

  // DEV_NOTE: The message that opened the socket goes out once the socket is ready
  const pendingText = useWidgetStore((state) => state.pendingText);
  const { sendMessage } = chat;
  useEffect(() => {
    if (!isReady || pendingText === null) return;
    storeApi.getState().patch({ pendingText: null });
    void sendMessage({ text: pendingText });
  }, [isReady, pendingText, sendMessage, storeApi]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      const store = storeApi.getState();
      if (!trimmed || store.isUnavailable) return;
      store.patch({ notice: null, draft: "" });
      if (isReady) {
        void sendMessage({ text: trimmed });
        return;
      }
      store.patch({ pendingText: trimmed, isSocketEnabled: true });
    },
    [isReady, sendMessage, storeApi],
  );

  const { stop, setMessages, messages } = chat;

  // DEV_NOTE: After "unavailable": the message the DO didn't take is sent again; after failed connects, the socket
  // simply tries again
  const retry = useCallback(() => {
    const store = storeApi.getState();
    store.patch({ isUnavailable: false, notice: null });
    failuresRef.current = 0;
    const unsent = messages.at(-1);
    if (unsent?.role === "user") {
      setMessages(messages.slice(0, -1));
      const text = unsent.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      send(text);
      return;
    }
    if (store.conversationPublicId || store.pendingText !== null) {
      store.patch({ isSocketEnabled: true });
    }
  }, [messages, send, setMessages, storeApi]);

  // DEV_NOTE: A new chat leaves the old conversation to close on its own once idle (the server does that)
  const newChat = useCallback(() => {
    if (chat.isStreaming || chat.status === "submitted") void stop();
    setMessages([]);
    setIsReady(false);
    setConversation(null);
    storeApi.getState().patch({
      isSocketEnabled: false,
      isUnavailable: false,
      notice: null,
      pendingText: null,
      draft: "",
      ratings: {},
      pendingRatings: {},
    });
  }, [chat.isStreaming, chat.status, setConversation, setMessages, stop, storeApi]);

  const rate = useCallback(
    (messageId: string, rating: Schemas.FeedbackRatingIntEnum) => {
      if (!isReady) return;
      const store = storeApi.getState();
      store.patch({ pendingRatings: { ...store.pendingRatings, [messageId]: rating } });
      agent.send(JSON.stringify({ type: Schemas.WIDGET_FEEDBACK_FRAME_TYPE, messageId, rating }));
    },
    [agent, isReady, storeApi],
  );

  return {
    messages,
    isStreaming: chat.isStreaming,
    isSubmitted: chat.status === "submitted",
    send,
    stop: () => void stop(),
    retry,
    newChat,
    rate,
  };
}

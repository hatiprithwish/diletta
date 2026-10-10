import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import * as Schemas from "@app/schemas";
import { useLatest } from "@/hooks/useLatest";
import { NO_CONNECT_FAILURES, nextConnectFailure } from "@/lib/connectFailures";
import { hostUserOf } from "@/lib/hostUser";
import { savedConversationKey, writeSavedConversation } from "@/lib/savedConversation";
import { parseServerFrame, ratingsOf } from "@/lib/serverFrames";
import { splitUnsent } from "@/lib/transcriptView";
import { useWidgetStore, useWidgetStoreApi } from "@/store/WidgetStoreContext";

// DEV_NOTE: The chat socket (GET /widget/ws, ADR 0001) through Think's client (useAgent + useAgentChat).
//
// When it opens: only for a first message, or when the panel opens on a saved conversation, so an idle visitor never
// creates a conversation. The token goes in Sec-WebSocket-Protocol (['diletta.v1', <jwt>]), fetched fresh from the
// host for every connect; never in the URL. Each token also tells the store which host user it is for (hashed).
//
// A new conversation: the server names it in its `conversation` frame; the widget saves the id and reconnects with it
// once, before sending anything, so a later reconnect (network drop, reload) resumes it instead of starting another.
// The message that opened the socket waits in pendingText until the socket is ready.
//
// The DO's own frames (lib/serverFrames.ts, parsed before use): unavailable / a refused send stop the pending request
// (the DO never answers it, so Think's client would wait forever) and keep the unsent message; closed ends the
// conversation, and a message it refused is sent again in a new one; feedback settles a thumb.
//
// One socket per conversation id: the session using this hook is remounted when the id changes (ChatSession's key), so
// each socket is created with its final address. (partysocket reconnects its old socket, at its old address, when the
// address changes right after `enabled` turned on, so the address must never change under a live hook.)
//
// Failed connects (lib/connectFailures.ts): refused upgrades drop the saved conversation, after which the widget goes
// idle (a new conversation opens only for a waiting message); a getToken failure never does. Too many failures of
// either kind show the unavailable state.
const AGENT_NAME = "conversation";
const SOCKET_PATH = "widget/ws";
const CLOSED_NOTICE =
  "This chat ended after a while without messages. Ask a new question any time.";
const FEEDBACK_NOT_SAVED_NOTICE = "Your feedback wasn't saved. Please try again.";

export function useConversation(params: Schemas.WidgetAppProps) {
  const { apiBase, chatbot } = params;
  const storeApi = useWidgetStoreApi();
  const conversationPublicId = useWidgetStore((state) => state.conversationPublicId);
  const isSocketEnabled = useWidgetStore((state) => state.isSocketEnabled);
  const isOpen = useWidgetStore((state) => state.isOpen);
  const [isReady, setIsReady] = useState(false);

  const getTokenRef = useLatest(params.getToken);
  const hasOpenedRef = useRef(false);
  const isTokenFailureRef = useRef(false);
  const failuresRef = useRef(NO_CONNECT_FAILURES);
  // DEV_NOTE: Read through a ref by the socket's handlers, which are created before the chat helpers exist
  const chatRef = useRef<ReturnType<typeof useAgentChat> | null>(null);

  // DEV_NOTE: Saved under the host user known at the time of the call, not at render: a token read mid-connect may
  // have just told the store who the user is
  const setConversation = useCallback(
    (publicId: string | null) => {
      const store = storeApi.getState();
      store.setConversation(publicId);
      if (store.hostUser) {
        writeSavedConversation(
          savedConversationKey({ apiBase, chatbot, hostUser: store.hostUser }),
          publicId,
        );
      }
    },
    [apiBase, chatbot, storeApi],
  );

  // DEV_NOTE: The conversation is over (closed, or its resume keeps being refused). The widget goes back to a new chat
  // and stays idle, unless a message is waiting: then it opens a new conversation for it.
  const endConversation = useCallback(() => {
    const store = storeApi.getState();
    setIsReady(false);
    chatRef.current?.setMessages([]);
    setConversation(null);
    store.patch({
      isSocketEnabled: store.pendingText !== null,
      ratings: {},
      pendingRatings: {},
      notice: store.pendingText === null ? CLOSED_NOTICE : null,
    });
  }, [setConversation, storeApi]);

  const failConnect = useCallback(
    (kind: Schemas.WidgetConnectFailureKindEnum) => {
      const store = storeApi.getState();
      const decision = nextConnectFailure({
        failures: failuresRef.current,
        kind,
        hasConversation: store.conversationPublicId !== null,
      });
      failuresRef.current = decision.failures;
      if (decision.action === Schemas.WidgetConnectFailureActionEnum.Unavailable) {
        store.patch({ isSocketEnabled: false, isUnavailable: true });
      } else if (decision.action === Schemas.WidgetConnectFailureActionEnum.DropConversation) {
        endConversation();
      }
    },
    [endConversation, storeApi],
  );
  const failConnectRef = useLatest(failConnect);

  const url = useMemo(() => new URL(apiBase), [apiBase]);
  const query = useMemo(() => {
    const entries: Record<string, string> = {};
    if (chatbot) entries.chatbot = chatbot;
    if (conversationPublicId) entries.conversation = conversationPublicId;
    return entries;
  }, [chatbot, conversationPublicId]);

  // DEV_NOTE: partysocket calls this for every connect. A getToken failure is counted here: partysocket swallows it and
  // retries with no close event (or with one from the previous, already closed socket, which isTokenFailureRef skips)
  const protocols = useCallback(async () => {
    isTokenFailureRef.current = false;
    let token: string;
    try {
      token = await getTokenRef.current();
    } catch (error) {
      isTokenFailureRef.current = true;
      failConnectRef.current(Schemas.WidgetConnectFailureKindEnum.Token);
      throw error;
    }
    const hostUser = await hostUserOf(token);
    if (hostUser && hostUser !== storeApi.getState().hostUser) {
      storeApi.getState().patch({ hostUser });
    }
    return [Schemas.WIDGET_SUBPROTOCOL, token];
  }, [failConnectRef, getTokenRef, storeApi]);

  const handleFrame = useCallback(
    (event: MessageEvent) => {
      const frame = parseServerFrame(event.data);
      if (!frame) return;
      const store = storeApi.getState();
      const chat = chatRef.current;

      switch (frame.type) {
        case "conversation": {
          if (store.conversationPublicId !== frame.conversation.publicId) {
            setIsReady(false);
            setConversation(frame.conversation.publicId);
            return;
          }
          failuresRef.current = NO_CONNECT_FAILURES;
          store.patch({
            ratings: ratingsOf(frame.feedback),
            pendingRatings: {},
            isUnavailable: false,
          });
          setIsReady(true);
          return;
        }
        case "closed": {
          // DEV_NOTE: A message sent just as the conversation closed was never taken; it goes to a new conversation
          const unsent = chat?.status === "submitted" ? splitUnsent(chat.messages) : null;
          if (chat && unsent) {
            void chat.stop();
            store.patch({ pendingText: store.pendingText ?? unsent.text });
          }
          endConversation();
          return;
        }
        case "unavailable": {
          void chat?.stop();
          store.patch({ isUnavailable: true, notice: null });
          return;
        }
        case "error": {
          const unsent = chat?.status === "submitted" ? splitUnsent(chat.messages) : null;
          if (chat && unsent) {
            void chat.stop();
            chat.setMessages(unsent.messages);
            store.patch({ draft: store.draft || unsent.text });
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
    [endConversation, setConversation, storeApi],
  );

  const handleOpen = useCallback(() => {
    hasOpenedRef.current = true;
  }, []);

  const handleClose = useCallback(() => {
    setIsReady(false);
    const wasOpen = hasOpenedRef.current;
    hasOpenedRef.current = false;
    if (isTokenFailureRef.current) {
      isTokenFailureRef.current = false;
      return;
    }
    if (!wasOpen) failConnect(Schemas.WidgetConnectFailureKindEnum.Refused);
  }, [failConnect]);

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
    failuresRef.current = NO_CONNECT_FAILURES;
    const unsent = splitUnsent(messages);
    if (unsent) {
      setMessages(unsent.messages);
      send(unsent.text);
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
    storeApi.getState().startOver(null);
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

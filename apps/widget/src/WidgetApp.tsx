import { useEffect, useMemo, useRef } from "react";
import type * as Schemas from "@app/schemas";
import ChatSession from "@/ChatSession";
import { useBootstrap } from "@/hooks/useBootstrap";
import {
  readSavedConversation,
  savedConversationKey,
  writeSavedConversation,
} from "@/lib/savedConversation";
import { useWidgetStore, useWidgetStoreApi } from "@/store/WidgetStoreContext";

// DEV_NOTE: The widget's top: the bootstrap read (kept across conversations), the saved conversation of the host user
// the tokens are for, and a chat session per conversation id (a new id remounts it with a socket at the new address).
//
// The host user is learned from every token (bootstrap and connect), so it can arrive after a chat started, or change:
//   first learned, with a chat already under way (started before the user was known): that chat is this user's, so
//     it is saved under their key rather than replaced;
//   first learned otherwise: their saved conversation, if any, is loaded;
//   changed (the host signed in as someone else without destroy()): the old user's chat is left as is and the new
//     user's saved conversation, if any, starts over in its place.
export default function WidgetApp({ apiBase, chatbot, getToken }: Schemas.WidgetAppProps) {
  const storeApi = useWidgetStoreApi();
  const conversationPublicId = useWidgetStore((state) => state.conversationPublicId);
  const hostUser = useWidgetStore((state) => state.hostUser);
  const bootstrap = useBootstrap({ apiBase, chatbot, getToken });

  const savedKey = useMemo(
    () => (hostUser ? savedConversationKey({ apiBase, chatbot, hostUser }) : null),
    [apiBase, chatbot, hostUser],
  );

  const knownKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!savedKey || savedKey === knownKeyRef.current) return;
    const isFirstUser = knownKeyRef.current === null;
    knownKeyRef.current = savedKey;
    const store = storeApi.getState();

    if (isFirstUser && (store.conversationPublicId !== null || store.isSocketEnabled)) {
      if (store.conversationPublicId) writeSavedConversation(savedKey, store.conversationPublicId);
      return;
    }
    if (isFirstUser) {
      store.setConversation(readSavedConversation(savedKey));
      return;
    }
    store.startOver(readSavedConversation(savedKey));
  }, [savedKey, storeApi]);

  return (
    <ChatSession
      key={conversationPublicId ?? "new"}
      apiBase={apiBase}
      chatbot={chatbot}
      getToken={getToken}
      bootstrap={bootstrap.state}
      onRetryBootstrap={bootstrap.retry}
    />
  );
}

import { useEffect, useMemo } from "react";
import ChatSession from "@/ChatSession";
import { useBootstrap } from "@/hooks/useBootstrap";
import { readSavedConversation, savedConversationKey } from "@/lib/savedConversation";
import { useWidgetStore, useWidgetStoreApi } from "@/store/WidgetStoreContext";

// DEV_NOTE: The widget's top: the bootstrap read (kept across conversations), the saved conversation once the host
// user is known, and a chat session per conversation id (a new id remounts it with a socket at the new address)
export default function WidgetApp({
  apiBase,
  chatbot,
  getToken,
}: {
  apiBase: string;
  chatbot: string | null;
  getToken: () => Promise<string>;
}) {
  const storeApi = useWidgetStoreApi();
  const conversationPublicId = useWidgetStore((state) => state.conversationPublicId);
  const bootstrap = useBootstrap({ apiBase, chatbot, getToken });
  const { hostUser } = bootstrap;

  const savedKey = useMemo(
    () => (hostUser ? savedConversationKey({ apiBase, chatbot, hostUser }) : null),
    [apiBase, chatbot, hostUser],
  );

  useEffect(() => {
    if (!savedKey) return;
    storeApi.getState().setConversation(readSavedConversation(savedKey));
  }, [savedKey, storeApi]);

  return (
    <ChatSession
      key={conversationPublicId ?? "new"}
      apiBase={apiBase}
      chatbot={chatbot}
      getToken={getToken}
      savedKey={savedKey}
      bootstrap={bootstrap.state}
      onRetryBootstrap={bootstrap.retry}
    />
  );
}

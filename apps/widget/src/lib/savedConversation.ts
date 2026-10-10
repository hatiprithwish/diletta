// DEV_NOTE: The conversation to resume after a reload, per platform, chatbot and host user, in the host page's
// localStorage. A per-viewer convenience: it may be missing or unwritable (private mode, blocked storage), and then
// the widget simply starts a new conversation. The server checks every resume, so a stale or foreign id only costs a
// refused connect (and is dropped).
const PREFIX = "diletta-widget:conversation:";

export function savedConversationKey(params: {
  apiBase: string;
  chatbot: string | null;
  hostUser: string;
}): string {
  return `${PREFIX}${params.apiBase}|${params.chatbot ?? "default"}|${params.hostUser}`;
}

export function readSavedConversation(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSavedConversation(key: string, conversationPublicId: string | null): void {
  try {
    if (conversationPublicId) {
      window.localStorage.setItem(key, conversationPublicId);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // DEV_NOTE: Storage blocked: the next reload starts a new conversation, nothing else depends on it
  }
}

import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: The review state of a conversation with no change requests yet
export const EMPTY_REVIEW: Schemas.WidgetChangeReviewState = {
  changeRequests: {},
  excluded: {},
  editing: {},
  sending: {},
  expanded: {},
  notices: {},
};

// DEV_NOTE: The panel shows the chat unless the visitor opened Your chats or a past chat
const CHAT_SCREEN: Schemas.WidgetScreen = { kind: "chat" };

// DEV_NOTE: One store per embedded widget (not a module singleton), so two widgets on a page, or a test, never share
// state. The script-tag controller and the React component both drive it.
export function createWidgetStore(
  theme: Schemas.WidgetThemeEnum,
  accent: Schemas.WidgetAccent | null = null,
): StoreApi<Schemas.WidgetStore> {
  return createStore<Schemas.WidgetStore>()((set) => ({
    isOpen: false,
    draft: "",
    theme,
    accent,
    hostUser: null,
    conversationPublicId: null,
    isSocketEnabled: false,
    isUnavailable: false,
    notice: null,
    pendingText: null,
    ratings: {},
    pendingRatings: {},
    notes: {},
    review: EMPTY_REVIEW,
    screen: CHAT_SCREEN,
    setOpen: (isOpen) => set({ isOpen }),
    setTheme: (nextTheme) => set({ theme: nextTheme }),
    setAccent: (nextAccent) => set({ accent: nextAccent }),
    setConversation: (conversationPublicId) => set({ conversationPublicId }),
    startOver: (conversationPublicId) =>
      set({
        conversationPublicId,
        isSocketEnabled: false,
        isUnavailable: false,
        notice: null,
        pendingText: null,
        draft: "",
        ratings: {},
        pendingRatings: {},
        notes: {},
        review: EMPTY_REVIEW,
        screen: CHAT_SCREEN,
      }),
    setScreen: (screen) => set({ screen }),
    patch: (patch) => set(patch),
  }));
}

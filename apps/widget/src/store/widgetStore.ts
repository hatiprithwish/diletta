import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: One store per embedded widget (not a module singleton), so two widgets on a page, or a test, never share
// state. The script-tag controller and the React component both drive it.
export function createWidgetStore(theme: Schemas.WidgetThemeEnum): StoreApi<Schemas.WidgetStore> {
  return createStore<Schemas.WidgetStore>()((set) => ({
    isOpen: false,
    draft: "",
    theme,
    conversationPublicId: null,
    isSocketEnabled: false,
    isUnavailable: false,
    notice: null,
    pendingText: null,
    ratings: {},
    pendingRatings: {},
    setOpen: (isOpen) => set({ isOpen }),
    setTheme: (nextTheme) => set({ theme: nextTheme }),
    setConversation: (conversationPublicId) => set({ conversationPublicId }),
    patch: (patch) => set(patch),
  }));
}

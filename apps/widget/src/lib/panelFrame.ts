import type { KeyboardEvent } from "react";

// DEV_NOTE: The open widget's frame, shared by every screen (the chat, Your chats, a past chat): 380 × 680 floating
// panel (smaller on a small screen, DESIGN.md §7), and Escape closes it. A non-modal dialog.
export const PANEL_FRAME_CLASS =
  "flex h-170 max-h-[calc(100dvh-56px)] w-95 max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl bg-background shadow-float";

export function closeOnEscape(onClose: () => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };
}

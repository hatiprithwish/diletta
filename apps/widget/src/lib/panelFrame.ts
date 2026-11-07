import type { KeyboardEvent } from "react";

// DEV_NOTE: The open widget's frame (components/PanelFrame.tsx): the 380 × 680 floating panel (smaller on a small
// screen, DESIGN.md §7), or the whole window in full screen
export const PANEL_FRAME_CLASS =
  "flex h-170 max-h-[calc(100dvh-56px)] w-95 max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl bg-background shadow-float";
export const FULL_SCREEN_FRAME_CLASS = "flex h-dvh w-screen flex-col overflow-hidden bg-background";

// DEV_NOTE: Full screen only: centres the content in a 760px column while the scroll bar stays at the window's edge
export const WIDE_COLUMN_CLASS = "px-[max(1.5rem,calc((100%-760px)/2))]";

const FOCUSABLE =
  "button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled])";

// DEV_NOTE: Escape closes the widget. In full screen (modal) Tab wraps around inside it, so focus never reaches the
// page hidden behind.
export function onFrameKeyDown(params: { isFullScreen: boolean; onClose: () => void }) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      params.onClose();
      return;
    }
    if (event.key !== "Tab" || !params.isFullScreen) return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    // DEV_NOTE: The widget lives in a shadow root, whose activeElement is the focused element inside it
    const active = (event.currentTarget.getRootNode() as Document | ShadowRoot).activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };
}

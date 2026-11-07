// DEV_NOTE: Whether the visitor last left the widget in full screen, in the host page's localStorage. A per-viewer
// convenience like the saved conversation: missing or unwritable storage means the floating panel.
const FULL_SCREEN_KEY = "diletta-widget:full-screen";

export function readSavedFullScreen(): boolean {
  try {
    return window.localStorage.getItem(FULL_SCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSavedFullScreen(isFullScreen: boolean): void {
  try {
    if (isFullScreen) {
      window.localStorage.setItem(FULL_SCREEN_KEY, "1");
    } else {
      window.localStorage.removeItem(FULL_SCREEN_KEY);
    }
  } catch {
    // DEV_NOTE: Storage blocked: the next page load opens the floating panel
  }
}

import { useSyncExternalStore } from "react";

// DEV_NOTE: Full screen is offered from the sm breakpoint up (640px): on a phone the floating panel already fills
// nearly the whole screen. No matchMedia (an old browser, a test): not wide.
const QUERY = "(min-width: 640px)";

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function isWide(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}

export function useIsWideScreen(): boolean {
  return useSyncExternalStore(subscribe, isWide, () => false);
}

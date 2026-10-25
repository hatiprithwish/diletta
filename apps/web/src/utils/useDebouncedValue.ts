import { useEffect, useState } from "react";

// DEV_NOTE: The value once it has stopped changing for delayMs, e.g. a search box's text before it becomes a query
// key, so typing sends one request per pause instead of one per keystroke
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

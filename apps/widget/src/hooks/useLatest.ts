import { useLayoutEffect, useRef } from "react";

// DEV_NOTE: A ref that always holds the latest value (updated after each render), for callbacks that must stay stable
// while reading a prop that may change, like the host's getToken
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

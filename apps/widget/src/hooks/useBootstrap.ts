import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as Schemas from "@app/schemas";
import { fetchBootstrap } from "@/lib/bootstrapApi";
import { hostUserOf } from "@/lib/hostUser";

// DEV_NOTE: Reads the widget's bootstrap (chatbot name, greeting, suggestions, launcher label) when the widget mounts
// and on retry, with a fresh token from the host each time. Also learns the host user the token is for, which keys
// the saved conversation. Opening nothing and creating nothing: a page view costs one read.
export function useBootstrap(params: {
  apiBase: string;
  chatbot: string | null;
  getToken: () => Promise<string>;
}) {
  const { apiBase, chatbot } = params;
  const getTokenRef = useRef(params.getToken);
  useLayoutEffect(() => {
    getTokenRef.current = params.getToken;
  });
  const [state, setState] = useState<Schemas.WidgetBootstrapState>({ status: "loading" });
  const [hostUser, setHostUser] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      let token: string;
      try {
        token = await getTokenRef.current();
      } catch {
        if (!controller.signal.aborted) setState({ status: "failed" });
        return;
      }
      const bootstrap = await fetchBootstrap({
        apiBase,
        chatbot,
        token,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setHostUser(hostUserOf(token));
      setState(bootstrap ? { status: "ready", bootstrap } : { status: "failed" });
    })();
    return () => controller.abort();
  }, [apiBase, chatbot, attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  return { state, hostUser, retry };
}

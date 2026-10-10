import { useCallback, useEffect, useState } from "react";
import type * as Schemas from "@app/schemas";
import { useLatest } from "@/hooks/useLatest";
import { fetchBootstrap } from "@/lib/bootstrapApi";
import { hostUserOf } from "@/lib/hostUser";
import { useWidgetStoreApi } from "@/store/WidgetStoreContext";

// DEV_NOTE: Reads the widget's bootstrap (chatbot name, greeting, suggestions, launcher label) when the widget mounts
// and on retry, with a fresh token from the host each time. Each token also tells the store which host user it is for
// (hashed), like every connect's token does. Opening nothing and creating nothing: a page view costs one read.
export function useBootstrap(params: Schemas.WidgetAppProps) {
  const { apiBase, chatbot } = params;
  const storeApi = useWidgetStoreApi();
  const getTokenRef = useLatest(params.getToken);
  const [state, setState] = useState<Schemas.WidgetBootstrapState>({ status: "loading" });
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
      const [bootstrap, hostUser] = await Promise.all([
        fetchBootstrap({ apiBase, chatbot, token, signal: controller.signal }),
        hostUserOf(token),
      ]);
      if (controller.signal.aborted) return;
      if (hostUser) storeApi.getState().patch({ hostUser });
      setState(bootstrap ? { status: "ready", bootstrap } : { status: "failed" });
    })();
    return () => controller.abort();
  }, [apiBase, chatbot, attempt, getTokenRef, storeApi]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }, []);
  return { state, retry };
}

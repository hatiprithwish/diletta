import * as Schemas from "@app/schemas";

// DEV_NOTE: Sends the host token (M3-5, M3-8; pure, no React): calls the host's getHostToken and sends what it gives in a
// host_token frame (never stored). One call at a time: a second send while one runs shares it. The host page owns the
// getter, so it is trusted for nothing: one that throws (even synchronously) or rejects is false, and one still
// pending after timeoutMs is false for its callers and stops being shared, so the next send calls it again (a token it
// gives later is still sent). No getter = false.
export function createHostTokenSender(params: {
  getHostToken: () => (() => Promise<string>) | null;
  send: (frame: string) => void;
  timeoutMs: number;
}): () => Promise<boolean> {
  let shared: Promise<boolean> | null = null;

  return async () => {
    const getHostToken = params.getHostToken();
    if (!getHostToken) return false;
    if (shared) return await shared;

    let cancelTimeout = () => {};
    const fetching = (async () => {
      try {
        const token = await Promise.resolve().then(getHostToken);
        params.send(JSON.stringify({ type: Schemas.WIDGET_HOST_TOKEN_FRAME_TYPE, token }));
        return true;
      } catch {
        return false;
      }
    })();
    const timedOut = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), params.timeoutMs);
      cancelTimeout = () => clearTimeout(timer);
    });
    const current = Promise.race([fetching, timedOut]);
    shared = current;
    void current.finally(() => {
      cancelTimeout();
      if (shared === current) shared = null;
    });
    return await current;
  };
}

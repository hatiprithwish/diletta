// DEV_NOTE: The Conversation DO's ask for a fresh host token (M3-8), one per DO instance, in memory only (it holds no
// token: the DO keeps that, pattern rule 3.11). Stateful (unlike the static providers/), so it lives in hostToken/.
//   - request(): asks every open socket (ask() sends token_needed, reason refresh, and returns how many it reached)
//     and resolves true on the next arrived(), false after waitMs, or false at once when no socket is open.
//   - Steps asking while one ask is pending share it.
//   - An ask that timed out isn't repeated for waitMs (unless a token arrives meanwhile): a batch of commits whose
//     widget gives no token waits once, not once per commit, and every later step parks at once.
//   - signal: an aborted step stops waiting (the shared ask goes on for the others).
// setTimer is injected for tests.
export default class HostTokenAsk {
  private readonly ask: () => number;
  private readonly waitMs: number;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => () => void;
  private pending: Promise<boolean> | null = null;
  private resolvePending: ((isArrived: boolean) => void) | null = null;
  private failedAt: number | null = null;

  constructor(params: {
    ask: () => number;
    waitMs: number;
    now?: () => number;
    setTimer?: (run: () => void, ms: number) => () => void;
  }) {
    this.ask = params.ask;
    this.waitMs = params.waitMs;
    this.now = params.now ?? (() => Date.now());
    this.setTimer =
      params.setTimer ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
  }

  async request(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (!this.pending) {
      if (this.failedAt !== null && this.now() - this.failedAt < this.waitMs) return false;
      if (this.ask() === 0) return false;
      this.pending = new Promise<boolean>((resolve) => {
        const cancel = this.setTimer(() => this.settle(false), this.waitMs);
        this.resolvePending = (isArrived) => {
          cancel();
          resolve(isArrived);
        };
      });
    }
    const pending = this.pending;
    if (!signal) return await pending;
    return await new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      void pending.then((isArrived) => {
        signal.removeEventListener("abort", onAbort);
        resolve(isArrived);
      });
    });
  }

  // DEV_NOTE: A host_token frame came: every waiting step goes on, and the next need asks again
  arrived(): void {
    this.failedAt = null;
    this.settle(true);
  }

  private settle(isArrived: boolean): void {
    const resolve = this.resolvePending;
    this.pending = null;
    this.resolvePending = null;
    if (!isArrived && resolve) this.failedAt = this.now();
    resolve?.(isArrived);
  }
}

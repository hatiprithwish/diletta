import { describe, it, expect } from "vitest";
import HostTokenAsk from "@/hostToken/HostTokenAsk";

// DEV_NOTE: The Conversation DO's ask for a fresh host token (M3-8), with a hand-driven clock and timers: one shared
// ask, no wait with no socket, the cooldown after a timed-out ask, a late token, and an aborted step
function setup(sockets = 1) {
  let now = 1_000;
  const timers: { at: number; run: () => void; isCancelled: boolean }[] = [];
  let asks = 0;
  const tokenAsk = new HostTokenAsk({
    ask: () => {
      asks += 1;
      return sockets;
    },
    waitMs: 100,
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run, isCancelled: false };
      timers.push(timer);
      return () => {
        timer.isCancelled = true;
      };
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (!timer.isCancelled && timer.at <= now) {
        timer.isCancelled = true;
        timer.run();
      }
    }
  };
  return { tokenAsk, advance, asks: () => asks };
}

describe("HostTokenAsk", () => {
  it("asks once for every step waiting meanwhile, and lets them all go on when a token arrives", async () => {
    const { tokenAsk, asks } = setup();
    const first = tokenAsk.request();
    const second = tokenAsk.request();
    tokenAsk.arrived();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(asks()).toBe(1);
    // DEV_NOTE: The next need asks again
    const third = tokenAsk.request();
    expect(asks()).toBe(2);
    tokenAsk.arrived();
    expect(await third).toBe(true);
  });

  it("doesn't wait when no socket is open, and asks again next time", async () => {
    const { tokenAsk, asks } = setup(0);
    expect(await tokenAsk.request()).toBe(false);
    expect(await tokenAsk.request()).toBe(false);
    expect(asks()).toBe(2);
  });

  it("gives up after the wait, and doesn't ask again for as long unless a token arrives", async () => {
    const { tokenAsk, advance, asks } = setup();
    const waiting = tokenAsk.request();
    advance(100);
    expect(await waiting).toBe(false);
    // DEV_NOTE: A batch's next commits park at once instead of waiting again
    expect(await tokenAsk.request()).toBe(false);
    expect(asks()).toBe(1);
    advance(100);
    const later = tokenAsk.request();
    expect(asks()).toBe(2);
    tokenAsk.arrived();
    expect(await later).toBe(true);
  });

  it("asks again at once after a late token ended the cooldown", async () => {
    const { tokenAsk, advance, asks } = setup();
    const waiting = tokenAsk.request();
    advance(100);
    expect(await waiting).toBe(false);
    tokenAsk.arrived();
    const next = tokenAsk.request();
    expect(asks()).toBe(2);
    tokenAsk.arrived();
    expect(await next).toBe(true);
  });

  it("stops an aborted step's wait while the shared ask goes on for the others", async () => {
    const { tokenAsk } = setup();
    const controller = new AbortController();
    const aborted = tokenAsk.request(controller.signal);
    const other = tokenAsk.request();
    controller.abort();
    expect(await aborted).toBe(false);
    tokenAsk.arrived();
    expect(await other).toBe(true);
    const done = new AbortController();
    done.abort();
    expect(await tokenAsk.request(done.signal)).toBe(false);
  });
});

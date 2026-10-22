import { describe, it, expect, vi } from "vitest";
import * as Schemas from "@app/schemas";
import { createHostTokenSender } from "@/lib/hostTokenSender";

// DEV_NOTE: The host token sender (M3-8): one getHostToken call at a time, and a getter that throws, rejects or hangs
// never blocks the next send
function setup(getHostToken: (() => Promise<string>) | null, timeoutMs = 1_000) {
  const frames: string[] = [];
  const sendHostToken = createHostTokenSender({
    getHostToken: () => getHostToken,
    send: (frame) => frames.push(frame),
    timeoutMs,
  });
  return { frames, sendHostToken };
}

const tokenFrame = (token: string) =>
  JSON.stringify({ type: Schemas.WIDGET_HOST_TOKEN_FRAME_TYPE, token });

describe("createHostTokenSender", () => {
  it("sends the host's token, and shares one call between sends made meanwhile", async () => {
    const getHostToken = vi.fn().mockResolvedValue("token-1");
    const { frames, sendHostToken } = setup(getHostToken);
    const results = await Promise.all([sendHostToken(), sendHostToken()]);
    expect(results).toEqual([true, true]);
    expect(getHostToken).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([tokenFrame("token-1")]);

    expect(await sendHostToken()).toBe(true);
    expect(getHostToken).toHaveBeenCalledTimes(2);
  });

  it("answers false with no getter", async () => {
    const { frames, sendHostToken } = setup(null);
    expect(await sendHostToken()).toBe(false);
    expect(frames).toEqual([]);
  });

  it("calls a getter again after it threw synchronously or rejected", async () => {
    const getHostToken = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw new Error("sync");
      })
      .mockRejectedValueOnce(new Error("async"))
      .mockResolvedValueOnce("token-3");
    const { frames, sendHostToken } = setup(getHostToken);
    expect(await sendHostToken()).toBe(false);
    expect(await sendHostToken()).toBe(false);
    expect(await sendHostToken()).toBe(true);
    expect(getHostToken).toHaveBeenCalledTimes(3);
    expect(frames).toEqual([tokenFrame("token-3")]);
  });

  it("stops waiting for a getter that hangs, and the next send calls it again", async () => {
    let release: (token: string) => void = () => {};
    const getHostToken = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)))
      .mockResolvedValueOnce("token-2");
    const { frames, sendHostToken } = setup(getHostToken, 20);
    expect(await sendHostToken()).toBe(false);
    expect(await sendHostToken()).toBe(true);
    expect(getHostToken).toHaveBeenCalledTimes(2);
    // DEV_NOTE: A token the hung getter gives later is still sent
    release("token-late");
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toEqual([tokenFrame("token-2"), tokenFrame("token-late")]);
  });
});

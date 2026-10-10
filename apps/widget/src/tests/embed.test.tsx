import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Schemas from "@app/schemas";
import "@/embed";
import DilettaWidget from "@/DilettaWidget";

// DEV_NOTE: The script-tag widget end to end in jsdom: window.Diletta.init, the bootstrap read, the shadow root, and
// the chat over a fake WebSocket standing in for the Conversation DO (Think's frames plus our own). Nothing here
// reaches a network.
const API_BASE = "https://platform.example.com";
const TOKEN = `h.${btoa(JSON.stringify({ sub: "host-user-1" })).replace(/=+$/, "")}.s`;
const BOOTSTRAP: Schemas.WidgetBootstrap = {
  chatbot: { publicId: "bot-1", name: "Registers Assistant" },
  widget: {
    greeting: "Hi, what do you need?",
    suggestions: ["Which inspections are overdue?"],
    launcherLabel: "Ask about your registers",
  },
};

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    super();
    FakeWebSocket.instances.push(this);
  }

  // DEV_NOTE: Answers Think's stream-resume probe the way the DO does when no reply is running
  send(data: string) {
    this.sent.push(data);
    const frame = JSON.parse(data) as { type: string; probeId?: string };
    if (frame.type === "cf_agent_stream_resume_request") {
      setTimeout(
        () =>
          this.push({
            type: "cf_agent_stream_resume_none",
            reason: "idle",
            probeId: frame.probeId,
          }),
        0,
      );
    }
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    // DEV_NOTE: Like a real socket, close fires later, not inside close()
    setTimeout(() => this.dispatch(new CloseEvent("close", { code, reason, wasClean: true })), 0);
  }

  // DEV_NOTE: The server side of the fake
  accept() {
    this.readyState = FakeWebSocket.OPEN;
    this.protocol = Schemas.WIDGET_SUBPROTOCOL;
    this.dispatch(new Event("open"));
  }

  push(frame: unknown) {
    this.dispatch(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  frames() {
    return this.sent.map((data) => JSON.parse(data) as Record<string, unknown> & { type: string });
  }

  private dispatch(event: Event) {
    const handler = (this as unknown as Record<string, unknown>)[`on${event.type}`];
    if (typeof handler === "function") handler.call(this, event);
    this.dispatchEvent(event);
  }
}

// DEV_NOTE: Node's own localStorage global shadows jsdom's (and throws without a file), so the test brings one
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  entries() {
    return [...this.values.values()];
  }
}

let storage: MemoryStorage;

// DEV_NOTE: The socket's address without partysocket's own client id (_pk), which the worker ignores
const socketAddress = (socket: FakeWebSocket | undefined) => {
  if (!socket) return null;
  const url = new URL(socket.url);
  url.searchParams.delete("_pk");
  return url.toString();
};

async function nextSocket(after: number, timeout = 2_000): Promise<FakeWebSocket> {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(after), { timeout });
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("No socket");
  return socket;
}

function shadow() {
  const host = document.querySelector("[data-diletta-widget]");
  const container = host?.shadowRoot?.querySelector("div");
  if (!container) throw new Error("Widget not mounted");
  return within(container);
}

const conversationFrame = (publicId: string, feedback: Schemas.WidgetFeedbackRating[] = []) => ({
  type: "conversation",
  conversation: { publicId },
  chatbot: { publicId: "bot-1", name: "Registers Assistant" },
  feedback,
});

function streamReply(socket: FakeWebSocket, requestId: string, messageId: string, text: string) {
  const chunks = [
    { type: "start", messageId },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish" },
  ];
  for (const chunk of chunks) {
    socket.push({
      type: "cf_agent_use_chat_response",
      id: requestId,
      body: JSON.stringify(chunk),
      done: false,
    });
  }
  socket.push({ type: "cf_agent_use_chat_response", id: requestId, body: "", done: true });
}

// DEV_NOTE: Where the widget keeps a host user's conversation: keyed by the sub's SHA-256, never the sub itself
async function savedKeyFor(sub: string, chatbot = "default") {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sub));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `diletta-widget:conversation:${API_BASE}|${chatbot}|${hash.join("")}`;
}

const CLOSED_NOTICE =
  "This chat ended after a while without messages. Ask a new question any time.";

function sendFromComposer(panel: ReturnType<typeof shadow>, text: string) {
  const input = panel.getByLabelText("Message");
  // DEV_NOTE: jsdom's typed input events don't cross into the shadow root's React tree; a change event does
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

// DEV_NOTE: What the script set on window, read without augmenting the global Window type
const diletta = (): Schemas.DilettaGlobal => {
  const value: unknown = Reflect.get(window, "Diletta");
  if (!value || typeof value !== "object") throw new Error("window.Diletta is not set");
  return value as Schemas.DilettaGlobal;
};

let getToken: ReturnType<typeof vi.fn<() => Promise<string>>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ isSuccess: true, bootstrap: BOOTSTRAP })),
  );
  vi.stubGlobal("fetch", fetchMock);
  getToken = vi.fn(async () => TOKEN);
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  act(() => {
    diletta().destroy();
  });
  vi.unstubAllGlobals();
});

describe("window.Diletta", () => {
  it("refuses bad options", () => {
    expect(() => diletta().init({ apiBase: "http://platform.example.com", getToken })).toThrow();
    expect(() =>
      diletta().init({
        apiBase: API_BASE,
        getToken: "nope" as unknown as () => Promise<string>,
      }),
    ).toThrow(TypeError);
  });

  it("reads the bootstrap with a bearer token, creates no socket, and shows the launcher label", async () => {
    act(() => {
      diletta().init({ apiBase: API_BASE, chatbot: "bot-1", getToken });
    });
    expect(
      await shadow().findByRole("button", { name: "Ask about your registers" }),
    ).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${API_BASE}/widget/bootstrap?chatbot=bot-1`);
    expect(init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(url.toString()).not.toContain(TOKEN);
    expect(FakeWebSocket.instances).toHaveLength(0);

    act(() => diletta().open());
    expect(
      await shadow().findByRole("heading", { name: "Hi, what do you need?" }),
    ).toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("starts a conversation on the first message, resumes it by id, and streams the reply", async () => {
    act(() => {
      diletta().init({ apiBase: API_BASE, getToken });
      diletta().open();
    });
    const panel = shadow();
    await userEvent.click(
      await panel.findByRole("button", { name: "Which inspections are overdue?" }),
    );

    // DEV_NOTE: First socket: no conversation yet, the token only in the subprotocol
    const first = await nextSocket(0);
    expect(socketAddress(first)).toBe("wss://platform.example.com/widget/ws");
    expect(first.protocols).toEqual([Schemas.WIDGET_SUBPROTOCOL, TOKEN]);
    act(() => {
      first.accept();
      first.push({ type: "cf_agent_chat_messages", messages: [] });
      first.push(conversationFrame("conv-1"));
    });

    // DEV_NOTE: The widget saves the id and reconnects with it before sending anything
    const second = await nextSocket(1);
    expect(socketAddress(second)).toBe("wss://platform.example.com/widget/ws?conversation=conv-1");
    expect(first.frames().some((frame) => frame.type === "cf_agent_use_chat_request")).toBe(false);
    act(() => {
      second.accept();
      second.push({ type: "cf_agent_chat_messages", messages: [] });
      second.push(conversationFrame("conv-1"));
    });

    await waitFor(() =>
      expect(second.frames().some((frame) => frame.type === "cf_agent_use_chat_request")).toBe(
        true,
      ),
    );
    const request = second.frames().find((frame) => frame.type === "cf_agent_use_chat_request");
    const body = JSON.parse(String((request?.init as { body: string }).body)) as {
      messages: { role: string; parts: { text: string }[] }[];
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.parts[0]?.text).toBe("Which inspections are overdue?");
    expect(storage.entries()).toContain("conv-1");

    act(() => streamReply(second, String(request?.id), "reply-1", "Two are overdue [1]."));
    expect(await panel.findByText(/Two are overdue/)).toBeInTheDocument();
    expect(await panel.findByRole("button", { name: "Helpful" })).toBeInTheDocument();

    // DEV_NOTE: Feedback goes out as our own frame and settles on the DO's answer
    await userEvent.click(panel.getByRole("button", { name: "Helpful" }));
    expect(second.frames().at(-1)).toEqual({
      type: Schemas.WIDGET_FEEDBACK_FRAME_TYPE,
      messageId: "reply-1",
      rating: Schemas.FeedbackRatingIntEnum.Up,
    });
    act(() =>
      second.push({
        type: "feedback",
        messageId: "reply-1",
        rating: Schemas.FeedbackRatingIntEnum.Up,
      }),
    );
    expect(panel.getByRole("button", { name: "Helpful" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the unavailable state when the DO can't answer, and sends the message again on retry", async () => {
    act(() => {
      diletta().init({ apiBase: API_BASE, getToken });
      diletta().open();
    });
    const panel = shadow();
    await userEvent.click(
      await panel.findByRole("button", { name: "Which inspections are overdue?" }),
    );
    const first = await nextSocket(0);
    act(() => {
      first.accept();
      first.push(conversationFrame("conv-2"));
    });
    const socket = await nextSocket(1);
    act(() => {
      socket.accept();
      socket.push(conversationFrame("conv-2"));
    });
    await waitFor(() =>
      expect(
        socket.frames().filter((frame) => frame.type === "cf_agent_use_chat_request"),
      ).toHaveLength(1),
    );

    act(() => socket.push({ type: "unavailable", message: "Temporarily unavailable" }));
    expect(await panel.findByText("Temporarily unavailable")).toBeInTheDocument();
    expect(panel.getByLabelText("Message")).toBeDisabled();
    expect(panel.getByText("Which inspections are overdue?")).toBeInTheDocument();

    await userEvent.click(panel.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(
        socket.frames().filter((frame) => frame.type === "cf_agent_use_chat_request"),
      ).toHaveLength(2),
    );
    expect(panel.queryByText("Temporarily unavailable")).not.toBeInTheDocument();
  });

  it("puts a refused message back in the composer and shows why", async () => {
    storage.setItem(await savedKeyFor("host-user-1"), "conv-3");
    act(() => {
      diletta().init({ apiBase: API_BASE, getToken });
      diletta().open();
    });
    const panel = shadow();
    const socket = await nextSocket(0);
    expect(socketAddress(socket)).toBe("wss://platform.example.com/widget/ws?conversation=conv-3");
    act(() => {
      socket.accept();
      socket.push(conversationFrame("conv-3"));
    });
    await panel.findByLabelText("Message");
    sendFromComposer(panel, "Too fast");
    await waitFor(() =>
      expect(socket.frames().some((frame) => frame.type === "cf_agent_use_chat_request")).toBe(
        true,
      ),
    );

    act(() => socket.push({ type: "error", message: Schemas.BUDGET_RATE_LIMIT_MESSAGE }));
    expect(await panel.findByText(Schemas.BUDGET_RATE_LIMIT_MESSAGE)).toBeInTheDocument();
    expect(panel.getByLabelText("Message")).toHaveValue("Too fast");
  });

  it("drops a saved conversation the server keeps refusing and waits for a message to start a new one", async () => {
    const key = await savedKeyFor("host-user-1");
    storage.setItem(key, "gone");
    act(() => {
      diletta().init({ apiBase: API_BASE, getToken });
      diletta().open();
    });
    const panel = shadow();
    const refused = await nextSocket(0);
    expect(refused.url).toContain("conversation=gone");
    act(() => refused.close(1006));
    const again = await nextSocket(1, 15_000);
    act(() => again.close(1006));

    expect(await panel.findByText(CLOSED_NOTICE)).toBeInTheDocument();
    expect(storage.getItem(key)).toBeNull();
    // DEV_NOTE: Idle: no new conversation is opened for a visitor who hasn't asked anything
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(FakeWebSocket.instances).toHaveLength(2);

    sendFromComposer(panel, "Hello again");
    const fresh = await nextSocket(2);
    expect(socketAddress(fresh)).toBe("wss://platform.example.com/widget/ws");
  }, 20_000);

  it("keeps the saved conversation when getToken fails, and connects to it on the next try", async () => {
    const key = await savedKeyFor("host-user-1");
    storage.setItem(key, "conv-4");
    getToken
      .mockImplementationOnce(async () => TOKEN)
      .mockImplementationOnce(async () => {
        throw new Error("Host session expired");
      });
    act(() => {
      diletta().init({ apiBase: API_BASE, getToken });
      diletta().open();
    });
    const socket = await nextSocket(0, 15_000);
    expect(socketAddress(socket)).toBe("wss://platform.example.com/widget/ws?conversation=conv-4");
    expect(getToken).toHaveBeenCalledTimes(3);
    expect(storage.getItem(key)).toBe("conv-4");
  }, 20_000);

  it("saves a conversation started before the bootstrap read finished, and keeps it after", async () => {
    let finishBootstrap: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishBootstrap = resolve;
        }),
    );
    act(() => {
      diletta().init({ apiBase: API_BASE, getToken });
      diletta().open();
    });
    const panel = shadow();
    sendFromComposer(panel, "Quick question");
    const first = await nextSocket(0);
    act(() => {
      first.accept();
      first.push(conversationFrame("conv-5"));
    });
    const second = await nextSocket(1);
    expect(socketAddress(second)).toBe("wss://platform.example.com/widget/ws?conversation=conv-5");
    expect(storage.getItem(await savedKeyFor("host-user-1"))).toBe("conv-5");

    await act(async () => {
      finishBootstrap(new Response(JSON.stringify({ isSuccess: true, bootstrap: BOOTSTRAP })));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(storage.getItem(await savedKeyFor("host-user-1"))).toBe("conv-5");
    expect(panel.getByText("Quick question")).toBeInTheDocument();
  });

  it("never keeps a raw host user id in localStorage", async () => {
    act(() => {
      diletta().init({ apiBase: API_BASE, getToken });
      diletta().open();
    });
    const panel = shadow();
    sendFromComposer(panel, "Hi");
    const socket = await nextSocket(0);
    act(() => {
      socket.accept();
      socket.push(conversationFrame("conv-6"));
    });
    await waitFor(() => expect(storage.entries()).toContain("conv-6"));
    expect(storage.key(0)).not.toContain("host-user-1");
  });
});

describe("<DilettaWidget />", () => {
  it("starts a fresh widget for a new chatbot, nothing of the old one's conversation kept", async () => {
    const view = render(<DilettaWidget apiBase={API_BASE} chatbot="bot-a" getToken={getToken} />);
    await userEvent.click(
      await shadow().findByRole("button", { name: "Open Registers Assistant" }),
    );
    sendFromComposer(shadow(), "Hello");
    const first = await nextSocket(0);
    act(() => {
      first.accept();
      first.push(conversationFrame("conv-a"));
    });
    const second = await nextSocket(1);
    expect(socketAddress(second)).toContain("conversation=conv-a");

    view.rerender(<DilettaWidget apiBase={API_BASE} chatbot="bot-b" getToken={getToken} />);
    expect(
      await shadow().findByRole("button", { name: "Open Registers Assistant" }),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(FakeWebSocket.instances.every((socket) => !socket.url.includes("chatbot=bot-b"))).toBe(
      true,
    );
    view.unmount();
  });
});

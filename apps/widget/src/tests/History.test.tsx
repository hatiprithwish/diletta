import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Schemas from "@app/schemas";
import History from "@/components/History";
import PastChat from "@/components/PastChat";

// DEV_NOTE: Your chats and a past chat, rendered from their view models
const ITEM: Schemas.WidgetConversationListItem = {
  publicId: "c2",
  title: "Add a fire drill for Hall B on Friday",
  isOpen: false,
  lastActivityAt: "2026-11-07T09:14:00.000Z",
};

function renderHistory(view: Schemas.WidgetHistoryView) {
  const actions = {
    onBack: vi.fn(),
    onNewChat: vi.fn(),
    onClose: vi.fn(),
    onPick: vi.fn(),
    onMore: vi.fn(),
    onRetry: vi.fn(),
  };
  render(<History chatbotName="Registers Assistant" view={view} {...actions} />);
  return actions;
}

describe("History", () => {
  it("lists the chats by day, picks one, starts a new chat and shows more", async () => {
    const actions = renderHistory({
      status: "ready",
      groups: [
        {
          label: "Today",
          rows: [{ item: ITEM, tone: Schemas.WidgetHistoryToneEnum.Ended, meta: "Ended · 09:14" }],
        },
      ],
      hasMore: true,
      isLoadingMore: false,
      moreFailed: false,
    });
    expect(screen.getByRole("heading", { name: "Your chats" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Today" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Add a fire drill/ }));
    expect(actions.onPick).toHaveBeenCalledWith(ITEM);
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(actions.onNewChat).toHaveBeenCalled();
    expect(actions.onMore).toHaveBeenCalled();
    expect(screen.getByText(/Older chats are removed after a while/)).toBeInTheDocument();
  });

  it("says when there are no chats yet, and goes back to the chat", async () => {
    const actions = renderHistory({
      status: "ready",
      groups: [],
      hasMore: false,
      isLoadingMore: false,
      moreFailed: false,
    });
    expect(screen.getByText("No past chats yet")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Back to chat" })[1]!);
    expect(actions.onBack).toHaveBeenCalled();
  });

  it("says when more chats didn't load, keeping the rows shown", () => {
    renderHistory({
      status: "ready",
      groups: [
        {
          label: "Today",
          rows: [{ item: ITEM, tone: Schemas.WidgetHistoryToneEnum.Ended, meta: "Ended · 09:14" }],
        },
      ],
      hasMore: true,
      isLoadingMore: false,
      moreFailed: true,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("More chats didn't load");
    expect(screen.getByRole("button", { name: /Add a fire drill/ })).toBeInTheDocument();
  });

  it("closes on Escape", () => {
    const actions = renderHistory({ status: "loading" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(actions.onClose).toHaveBeenCalled();
  });
});

describe("PastChat", () => {
  const props = {
    item: ITEM,
    meta: "Ended · Today, 09:14",
    linkOrigins: [],
    onBack: vi.fn(),
    onNewChat: vi.fn(),
    onClose: vi.fn(),
    onRetry: vi.fn(),
  };

  it("shows the messages and sources read-only, with Start a new chat", async () => {
    render(
      <PastChat
        {...props}
        state={{
          status: "ready",
          conversation: {
            ...ITEM,
            messages: [
              { publicId: "m1", role: "user", text: "Add a fire drill", citations: [] },
              {
                publicId: "m2",
                role: "assistant",
                text: "Which time works? [1]",
                citations: [
                  { n: 1, documentPublicId: "d1", title: "Fire drill policy", sourceUrl: null },
                ],
              },
            ],
          },
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: ITEM.title })).toBeInTheDocument();
    expect(screen.getByText("Ended · Today, 09:14")).toBeInTheDocument();
    expect(screen.getByText("Add a fire drill")).toBeInTheDocument();
    expect(screen.getByText("Fire drill policy")).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    await userEvent.click(screen.getByRole("button", { name: "Back to your chats" }));
    expect(props.onNewChat).toHaveBeenCalled();
    expect(props.onBack).toHaveBeenCalled();
  });

  it("says when the chat is no longer available, and offers a retry when it didn't load", async () => {
    const { unmount } = render(<PastChat {...props} state={{ status: "notFound" }} />);
    expect(screen.getByText("This chat isn't available any more.")).toBeInTheDocument();
    unmount();
    render(<PastChat {...props} state={{ status: "failed" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Schemas from "@app/schemas";
import Panel from "@/components/Panel";
import Launcher from "@/components/Launcher";

// DEV_NOTE: The widget states of DESIGN.md §7 from plain view models: what shows, and which action each control sends
const base: Schemas.WidgetPanelView = {
  chatbotName: "Registers Assistant",
  status: Schemas.WidgetStatusEnum.Online,
  welcome: null,
  messages: [],
  isUnavailable: false,
  isBusy: false,
  canStop: false,
  notice: null,
  draft: "",
};

function renderPanel(view: Partial<Schemas.WidgetPanelView>) {
  const actions = {
    onSend: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
    onNewChat: vi.fn(),
    onClose: vi.fn(),
    onRate: vi.fn(),
    onDraftChange: vi.fn(),
  };
  render(<Panel view={{ ...base, ...view }} {...actions} />);
  return actions;
}

const reply = (
  patch: Partial<Schemas.WidgetAssistantMessageView>,
): Schemas.WidgetAssistantMessageView => ({
  role: "assistant",
  id: "a1",
  text: "",
  steps: [],
  citations: [],
  isStreaming: false,
  canRate: false,
  rating: null,
  ...patch,
});

describe("Launcher", () => {
  it("opens from the circle and from the label", async () => {
    const onOpen = vi.fn();
    render(
      <Launcher
        label="Ask about your registers"
        chatbotName="Registers Assistant"
        onOpen={onOpen}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open Registers Assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask about your registers" }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("Panel", () => {
  it("welcomes a new chat with the greeting and sends a suggestion", async () => {
    const actions = renderPanel({
      welcome: {
        greeting: "Hi, what do you need?\nI can answer questions about your registers.",
        suggestions: ["Which inspections are overdue?"],
      },
    });
    expect(screen.getByRole("heading", { name: "Hi, what do you need?" })).toBeInTheDocument();
    expect(screen.getByText("I can answer questions about your registers.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Online");
    await userEvent.click(screen.getByRole("button", { name: "Which inspections are overdue?" }));
    expect(actions.onSend).toHaveBeenCalledWith("Which inspections are overdue?");
  });

  it("sends the draft on Enter, and has New chat and Close", async () => {
    const actions = renderPanel({ draft: "How many are due?" });
    await userEvent.type(screen.getByLabelText("Message"), "{Enter}");
    expect(actions.onSend).toHaveBeenCalledWith("How many are due?");
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await userEvent.click(screen.getByRole("button", { name: "Close assistant" }));
    expect(actions.onNewChat).toHaveBeenCalled();
    expect(actions.onClose).toHaveBeenCalled();
  });

  it("shows a running reply's steps, its text and Stop", async () => {
    const actions = renderPanel({
      status: Schemas.WidgetStatusEnum.Working,
      isBusy: true,
      canStop: true,
      messages: [
        { role: "user", id: "u1", text: "Which are open?" },
        reply({
          text: "Building B has 3 open inspections",
          isStreaming: true,
          steps: [
            {
              id: "s1",
              label: "Searched the help docs",
              detail: "3 results",
              state: Schemas.WidgetToolStepStateEnum.Done,
            },
            {
              id: "s2",
              label: "Searching the help docs",
              detail: null,
              state: Schemas.WidgetToolStepStateEnum.Running,
            },
          ],
        }),
      ],
    });
    expect(screen.getByText("Searched the help docs")).toBeInTheDocument();
    expect(screen.getByText("3 results")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Searching the help docs" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Working");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Helpful" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(actions.onStop).toHaveBeenCalled();
  });

  it("shows an answer's citation chips, its sources and the thumbs", async () => {
    const actions = renderPanel({
      messages: [
        reply({
          text: "Open **Settings → Fields** [1].\n\n<script>alert(1)</script>",
          canRate: true,
          rating: Schemas.FeedbackRatingIntEnum.Up,
          citations: [
            {
              n: 1,
              documentPublicId: "d1",
              title: "Add and manage custom fields",
              sourceUrl: "https://help.example.com/fields",
            },
          ],
        }),
      ],
    });
    expect(screen.getByLabelText("Source 1")).toHaveTextContent("1");
    const sources = screen.getByLabelText("Sources");
    const link = within(sources).getByRole("link", { name: /Add and manage custom fields/ });
    expect(link).toHaveAttribute("href", "https://help.example.com/fields");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Not helpful" }));
    expect(actions.onRate).toHaveBeenCalledWith("a1", Schemas.FeedbackRatingIntEnum.Down);
  });

  it("shows the unavailable card with a retry and disables the composer", async () => {
    const actions = renderPanel({
      status: Schemas.WidgetStatusEnum.Unavailable,
      isUnavailable: true,
      messages: [{ role: "user", id: "u1", text: "How many are due next week?" }],
    });
    expect(screen.getByText("Temporarily unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Your data hasn't changed/)).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    expect(screen.getByPlaceholderText("Assistant unavailable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(actions.onRetry).toHaveBeenCalled();
  });
});

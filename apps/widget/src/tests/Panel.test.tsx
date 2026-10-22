import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Schemas from "@app/schemas";
import Panel from "@/components/Panel";
import Launcher from "@/components/Launcher";
import { toChangeCard } from "@/lib/changeRequestView";
import { EMPTY_REVIEW } from "@/store/widgetStore";

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
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onSaveEdits: vi.fn(),
    onEditValue: vi.fn(),
    onToggleRecord: vi.fn(),
    onShowMore: vi.fn(),
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
  changeCards: [],
  ...patch,
});

describe("Launcher", () => {
  it("opens from the circle and from the label", async () => {
    const onOpen = vi.fn();
    render(
      <Launcher
        label="Ask about your registers"
        chatbotName="Registers Assistant"
        autoFocus={false}
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

  it("is a dialog with a live chat log, focuses the composer, and closes on Escape", () => {
    const actions = renderPanel({
      messages: [{ role: "user", id: "u1", text: "Hello" }],
    });
    const dialog = screen.getByRole("dialog", { name: "Registers Assistant" });
    expect(within(dialog).getByRole("log")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByLabelText("Message")).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Escape" });
    expect(actions.onClose).toHaveBeenCalled();
  });

  it("never sends on the Enter that confirms an IME conversion", () => {
    const actions = renderPanel({ draft: "こんにち" });
    const input = screen.getByLabelText("Message");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(actions.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions.onSend).toHaveBeenCalledWith("こんにち");
  });
});

// DEV_NOTE: Review cards (M3-5): which action each control sends, from cards the view builder made
describe("Change request cards", () => {
  const editable: Schemas.ChangeRequestEditableField = {
    field: "amount",
    type: Schemas.ChangeRequestFieldTypeEnum.Number,
    enumValues: null,
    format: null,
    isRequired: false,
  };
  const member = (publicId: string): Schemas.WidgetChangeRequest => ({
    publicId,
    toolName: "update_record",
    toolCallId: null,
    kind: Schemas.ChangeRequestKindEnum.Update,
    changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Proposed,
    changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.Proposed,
    summary: "update_record: 1 field changed",
    changes: [
      {
        field: "amount",
        before: { isFound: true, value: 120 },
        after: { isFound: true, value: 300 },
        isChanged: true,
      },
      {
        field: "recordId",
        before: { isFound: true, value: `EXT-${publicId}` },
        after: { isFound: true, value: `EXT-${publicId}` },
        isChanged: false,
      },
    ],
    changeCount: 1,
    expiresAt: null,
    isUndoable: true,
    wasEdited: false,
    editableFields: [editable],
  });
  const cardOf = (
    members: Schemas.WidgetChangeRequest[],
    patch: Partial<Schemas.WidgetChangeReviewState> = {},
  ) =>
    toChangeCard(
      { messageId: "a1", cardId: "card-1", members },
      {
        ...EMPTY_REVIEW,
        changeRequests: Object.fromEntries(members.map((m) => [m.publicId, m])),
        ...patch,
      },
    );
  const withCard = (card: Schemas.WidgetChangeCardView) => ({
    messages: [reply({ text: "Ready for your review.", changeCards: [card] })],
  });

  it("shows the diff and sends approve, edit and reject for the whole card", async () => {
    const actions = renderPanel(withCard(cardOf([member("1"), member("2")])));
    const card = screen.getByRole("region", { name: "Update 2 records" });
    expect(within(card).getByText("EXT-1")).toBeInTheDocument();
    expect(within(card).getAllByText("300")).toHaveLength(2);
    await userEvent.click(within(card).getByRole("button", { name: "Approve 2 changes" }));
    expect(actions.onApprove).toHaveBeenCalledWith("card-1");
    await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
    expect(actions.onEdit).toHaveBeenCalledWith("card-1");
    await userEvent.click(within(card).getByRole("button", { name: "Reject" }));
    expect(actions.onReject).toHaveBeenCalledWith("card-1");
  });

  it("edits a value, removes a record and saves in the editor", async () => {
    const actions = renderPanel(
      withCard(cardOf([member("1"), member("2")], { editing: { "card-1": {} } })),
    );
    const card = screen.getByRole("region", { name: "Editing 2 changes" });
    const [first] = within(card).getAllByRole("textbox", { name: "amount" });
    if (!first) throw new Error("No amount input");
    fireEvent.change(first, { target: { value: "450" } });
    expect(actions.onEditValue).toHaveBeenCalledWith("card-1", "1", "amount", "450");
    const [remove] = within(card).getAllByRole("button", { name: "Remove this record" });
    if (!remove) throw new Error("No remove button");
    await userEvent.click(remove);
    expect(actions.onToggleRecord).toHaveBeenCalledWith("card-1", "1");
    await userEvent.click(within(card).getByRole("button", { name: "Save edits" }));
    expect(actions.onSaveEdits).toHaveBeenCalledWith("card-1");
    await userEvent.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(actions.onCancelEdit).toHaveBeenCalledWith("card-1");
  });

  it("ticks records in bulk review and shows the rest on request", async () => {
    const members = Array.from({ length: 8 }, (_, index) => member(String(index)));
    const actions = renderPanel(withCard(cardOf(members, { excluded: { "2": true } })));
    const card = screen.getByRole("region", { name: "Update 7 of 8 records" });
    const unticked = within(card).getByRole("checkbox", { name: "Include EXT-2" });
    expect(unticked).not.toBeChecked();
    await userEvent.click(unticked);
    expect(actions.onToggleRecord).toHaveBeenCalledWith("card-1", "2");
    await userEvent.click(within(card).getByRole("button", { name: "Show 2 more" }));
    expect(actions.onShowMore).toHaveBeenCalledWith("card-1");
    expect(within(card).getByRole("button", { name: "Approve 7 changes" })).toBeEnabled();
  });

  it("waits while an answer is on its way, and shows each outcome once decided", () => {
    const sending = cardOf([member("1")], { sending: { "card-1": true } });
    const { unmount } = render(<Panel view={{ ...base, ...withCard(sending) }} {...noopActions} />);
    expect(screen.getByRole("button", { name: "Approve 1 change" })).toBeDisabled();
    unmount();

    const decided = cardOf([
      { ...member("1"), changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Rejected },
    ]);
    renderPanel(withCard(decided));
    expect(screen.getByText("Rejected. Nothing changed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve/ })).not.toBeInTheDocument();
  });
});

const noopActions = {
  onSend: vi.fn(),
  onStop: vi.fn(),
  onRetry: vi.fn(),
  onNewChat: vi.fn(),
  onClose: vi.fn(),
  onRate: vi.fn(),
  onDraftChange: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onEdit: vi.fn(),
  onCancelEdit: vi.fn(),
  onSaveEdits: vi.fn(),
  onEditValue: vi.fn(),
  onToggleRecord: vi.fn(),
  onShowMore: vi.fn(),
};

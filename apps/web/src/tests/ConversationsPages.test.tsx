import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { Route as ConversationsRoute } from "@/routes/_authenticated/conversations/index";
import { Route as ConversationRoute } from "@/routes/_authenticated/conversations/$id/index";
import { Route as ChangeRoute } from "@/routes/_authenticated/changes/$id/index";
import Utilities from "@/utils";

vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: "user_1",
    getToken: async () => "t",
  }),
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const ROW_PRIYA: Schemas.ConversationListItem = {
  publicId: "conv_priya",
  userName: "Priya Shah",
  title: "Close the three Building B inspections",
  isContentPurged: false,
  conversationStatus: Schemas.ConversationStatusIntEnum.Closed,
  conversationStatusLabel: Schemas.ConversationStatusLabelEnum.Closed,
  outcome: Schemas.ConversationOutcomeIntEnum.ActionDone,
  outcomeLabel: Schemas.ConversationOutcomeLabelEnum.ActionDone,
  turnCount: 2,
  chatbotName: "eRegister Assistant",
  configVersion: 12,
  rating: Schemas.FeedbackRatingIntEnum.Up,
  ratingLabel: Schemas.FeedbackRatingLabelEnum.Up,
  createdAt: "2026-10-20T14:10:00.000Z",
  lastActivityAt: "2026-10-20T14:12:00.000Z",
};

const ROW_ANON: Schemas.ConversationListItem = {
  ...ROW_PRIYA,
  publicId: "conv_anon",
  userName: null,
  title: null,
  isContentPurged: true,
  outcome: null,
  outcomeLabel: Schemas.CONVERSATION_IN_PROGRESS_LABEL,
  configVersion: null,
  rating: Schemas.FeedbackRatingIntEnum.Down,
  ratingLabel: Schemas.FeedbackRatingLabelEnum.Down,
};

const LIST: Schemas.GetConversationsApiResponse = {
  isSuccess: true,
  conversations: [ROW_PRIYA, ROW_ANON],
  totalRecords: 1486,
  tabCounts: { all: 1486, needs_attention: 9, rated_down: 31 },
  configOptions: [{ publicId: "cfg_12", chatbotName: "eRegister Assistant", configVersion: 12 }],
};

const DETAIL: Schemas.ConversationDetail = {
  ...ROW_PRIYA,
  costUsd: "0.041000",
  costNote: Schemas.ConversationCostNoteEnum.Pending,
  isFlagged: false,
  turns: [
    {
      number: 1,
      startedAt: "2026-10-20T14:10:00.000Z",
      costUsd: "0.012000",
      costNote: null,
      entries: [
        {
          kind: Schemas.ConversationTurnEntryKindEnum.Message,
          publicId: "m1",
          role: Schemas.MessageRoleIntEnum.User,
          roleLabel: Schemas.MessageRoleLabelEnum.User,
          text: "Which Building B inspections are still open?",
          citations: [],
          rating: null,
          ratingLabel: null,
        },
        {
          kind: Schemas.ConversationTurnEntryKindEnum.Message,
          publicId: "m2",
          role: Schemas.MessageRoleIntEnum.Assistant,
          roleLabel: Schemas.MessageRoleLabelEnum.Assistant,
          text: "3 inspections are open [1].",
          citations: [
            { n: 1, title: "Fire safety", sourceUrl: "https://help.example.com/fire" },
            { n: 2, title: "Bad link", sourceUrl: "javascript:alert(1)" },
          ],
          rating: Schemas.FeedbackRatingIntEnum.Up,
          ratingLabel: Schemas.FeedbackRatingLabelEnum.Up,
        },
      ],
    },
    {
      number: 2,
      startedAt: "2026-10-20T14:11:00.000Z",
      costUsd: "0.029000",
      costNote: Schemas.ConversationCostNoteEnum.Pending,
      entries: [
        {
          kind: Schemas.ConversationTurnEntryKindEnum.Tool,
          publicId: "tc1",
          toolName: "update_record",
          toolVersion: 3,
          toolCallStatus: Schemas.ToolCallStatusIntEnum.Ok,
          toolCallStatusLabel: Schemas.ToolCallStatusLabelEnum.Ok,
          errorCode: null,
          errorLabel: null,
          change: {
            publicId: "cr_1",
            summary: "update_record: 3 records",
            changeCount: 3,
            changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
            changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.NeedsHuman,
            errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
            errorLabel: Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.undo_failed,
          },
        },
      ],
    },
  ],
};

const CHANGE: Schemas.ChangeRequestDetail = {
  publicId: "cr_1",
  summary: "update_record: 3 records",
  changeCount: 3,
  changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
  changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.NeedsHuman,
  errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
  errorLabel: Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.undo_failed,
  toolName: "update_record",
  toolVersion: 3,
  wasEdited: true,
  undoUntil: null,
  createdAt: "2026-10-20T14:11:00.000Z",
  updatedAt: "2026-10-20T14:12:00.000Z",
  conversation: {
    publicId: "conv_priya",
    title: "Close the three Building B inspections",
    chatbotName: "eRegister Assistant",
    userName: "Priya Shah",
  },
};

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function mockApi(handler: Handler) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// DEV_NOTE: The list, the detail and the one-change detail, each answered from fixtures
function defaultApi(url: string, init?: RequestInit) {
  if (url.includes("/change-requests/")) {
    return { status: 200, body: { isSuccess: true, changeRequest: CHANGE } };
  }
  if (url.includes("/flag")) {
    expect(init?.method).toBe("POST");
    return {
      status: 201,
      body: { isSuccess: true, isCreated: true, qualityIssuePublicId: "qi_1" },
    };
  }
  if (url.includes("/export")) {
    return {
      status: 200,
      body: { isSuccess: true, conversations: [ROW_PRIYA], isTruncated: false },
    };
  }
  if (url.includes("/dashboard/conversations/conv_priya")) {
    return { status: 200, body: { isSuccess: true, conversation: DETAIL } };
  }
  return { status: 200, body: LIST };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pages = [
    ["/conversations", ConversationsRoute],
    ["/conversations/$id", ConversationRoute],
    ["/changes/$id", ChangeRoute],
  ] as const;
  const routes = pages.map(([to, route]) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: to,
      validateSearch: route.options.validateSearch,
      component: route.options.component,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  toast.error.mockReset();
  toast.success.mockReset();
});

describe("Conversations list", () => {
  it("shows the rows, the tab counts and asks for the first page", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/conversations");

    expect(await screen.findByText("Priya Shah")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/dashboard/conversations?pageNo=1&pageSize=${Schemas.CONVERSATIONS_PAGE_SIZE}`,
    );
    expect(screen.getByRole("radio", { name: /All\s*1,486/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Needs attention\s*9/ })).toBeInTheDocument();
    const priya = screen.getByRole("row", { name: /Priya Shah/ });
    expect(within(priya).getByText("Action done")).toBeInTheDocument();
    expect(within(priya).getByText("v12")).toBeInTheDocument();
    const anon = screen.getByRole("row", { name: /Unnamed user/ });
    expect(within(anon).getByText("Content deleted")).toBeInTheDocument();
    expect(within(anon).getByText(Schemas.CONVERSATION_IN_PROGRESS_LABEL)).toBeInTheDocument();
    expect(within(anon).getByLabelText("Rated down")).toBeInTheDocument();
    expect(screen.getByText("1–25 of 1,486")).toBeInTheDocument();
  });

  it("filters by tab through the URL and back to page 1", async () => {
    const fetchMock = mockApi(defaultApi);
    const router = renderPage("/conversations?page=3");
    await screen.findByText("Priya Shah");

    await userEvent.click(screen.getByRole("radio", { name: /Needs attention/ }));
    expect(router.state.location.search).toEqual({ tab: "needs_attention" });
    const last = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(last).toContain("tab=needs_attention");
    expect(last).toContain("pageNo=1");
  });

  it("offers to clear the filters when nothing matches", async () => {
    mockApi(() => ({
      status: 200,
      body: { ...LIST, conversations: [], totalRecords: 0 },
    }));
    const router = renderPage("/conversations?outcome=idk");

    expect(await screen.findByText("No conversations match these filters.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.state.location.search).toEqual({});
  });

  it("says when there are no conversations at all", async () => {
    mockApi(() => ({
      status: 200,
      body: {
        ...LIST,
        conversations: [],
        totalRecords: 0,
        tabCounts: { all: 0, needs_attention: 0, rated_down: 0 },
      },
    }));
    renderPage("/conversations");
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument();
  });

  it("shows an error with a retry when the list fails", async () => {
    let calls = 0;
    mockApi((url, init) => {
      calls += 1;
      return calls === 1 ? { status: 500, body: { isSuccess: false } } : defaultApi(url, init);
    });
    renderPage("/conversations");

    expect(await screen.findByText("Conversations didn't load")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Priya Shah")).toBeInTheDocument();
  });

  it("exports the filtered conversations as a CSV", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const fetchMock = mockApi(defaultApi);
    renderPage("/conversations?outcome=answered");
    await screen.findByText("Priya Shah");

    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await vi.waitFor(() => toast.success.mock.calls.length)).toBe(1);
    expect(toast.success).toHaveBeenCalledWith("Exported 1 conversation.");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/dashboard/conversations/export?outcome=answered"),
      ),
    ).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe("Conversation detail", () => {
  it("opens from a row and shows each turn's cost, messages and tool calls", async () => {
    mockApi(defaultApi);
    const router = renderPage("/conversations?tab=rated_down");
    await screen.findByText("Priya Shah");

    await userEvent.click(screen.getByRole("link", { name: ROW_PRIYA.title! }));
    expect(router.state.location.pathname).toBe("/conversations/conv_priya");
    expect(router.state.location.search).toEqual({ tab: "rated_down" });

    const card = await screen.findByRole("region", { name: "Conversation" });
    expect(await within(card).findByText("Turn 1")).toBeInTheDocument();
    expect(within(card).getByText(/\$0\.041/)).toBeInTheDocument();
    expect(within(card).getByText("$0.012")).toBeInTheDocument();
    expect(within(card).getAllByText(/some cost is still coming in/)).toHaveLength(2);
    expect(
      within(card).getByText("Which Building B inspections are still open?"),
    ).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Fire safety" })).toHaveAttribute(
      "href",
      "https://help.example.com/fire",
    );
    expect(within(card).queryByRole("link", { name: "Bad link" })).not.toBeInTheDocument();
    expect(within(card).getByText("update_record")).toBeInTheDocument();
    expect(within(card).getByText("Needs a person")).toBeInTheDocument();
    expect(
      within(card).getByText(Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.undo_failed),
    ).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Open change" })).toHaveAttribute(
      "href",
      "/changes/cr_1",
    );
  });

  it("flags the conversation once and shows it flagged", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/conversations/conv_priya");

    await userEvent.click(await screen.findByRole("button", { name: "Flag conversation" }));
    expect(await screen.findByRole("button", { name: "Flagged" })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/conv_priya/flag"))).toBe(
      true,
    );
    expect(toast.success).toHaveBeenCalled();
  });

  it("toasts when the flag fails and leaves the button", async () => {
    mockApi((url, init) =>
      url.includes("/flag") ? { status: 500, body: { isSuccess: false } } : defaultApi(url, init),
    );
    renderPage("/conversations/conv_priya");

    await userEvent.click(await screen.findByRole("button", { name: "Flag conversation" }));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Flag conversation" })).toBeEnabled();
  });

  it("says a missing conversation isn't available", async () => {
    mockApi((url, init) =>
      url.includes("/dashboard/conversations/conv_gone")
        ? { status: 404, body: { isSuccess: false, isNotFound: true } }
        : defaultApi(url, init),
    );
    renderPage("/conversations/conv_gone");
    expect(await screen.findByText(/This conversation isn't available/)).toBeInTheDocument();
  });
});

describe("Change detail", () => {
  it("shows the change, why it needs a person and links back to its conversation", async () => {
    mockApi(defaultApi);
    renderPage("/changes/cr_1");

    expect(await screen.findByText("update_record: 3 records")).toBeInTheDocument();
    expect(screen.getByText("Needs a person")).toBeInTheDocument();
    expect(
      screen.getByText(Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.undo_failed),
    ).toBeInTheDocument();
    expect(screen.getByText("Edited by the user before approval")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: CHANGE.conversation.title! })).toHaveAttribute(
      "href",
      "/conversations/conv_priya",
    );
  });

  it("says a missing change isn't available", async () => {
    mockApi(() => ({ status: 404, body: { isSuccess: false, isNotFound: true } }));
    renderPage("/changes/cr_gone");
    expect(await screen.findByText(/This change isn't available/)).toBeInTheDocument();
  });
});

describe("Utilities.toCsv", () => {
  it("quotes every cell and defuses spreadsheet formulas", () => {
    expect(
      Utilities.toCsv([
        ["Name", "Note"],
        ['Say "hi"', "=HYPERLINK(1)"],
        ["@SUM", "-2"],
      ]),
    ).toBe('"Name","Note"\r\n"Say ""hi""","\'=HYPERLINK(1)"\r\n"\'@SUM","\'-2"');
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
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
import { Route as FeedbackRoute } from "@/routes/_authenticated/quality/feedback/index";
import { Route as FeedbackThemeRoute } from "@/routes/_authenticated/quality/feedback/$id/index";

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

// DEV_NOTE: Quality › User feedback (M7-10): the themes list, one theme's notes, Mark resolved and Dismiss
const THEME: Schemas.FeedbackThemeListItem = {
  publicId: "ft_1",
  chatbotName: "eRegister Assistant",
  label: "Answers quote the old fire drill schedule",
  rating: Schemas.FeedbackRatingIntEnum.Down,
  ratingLabel: Schemas.FeedbackRatingLabelEnum.Down,
  feedbackThemeStatus: Schemas.FeedbackThemeStatusIntEnum.Open,
  feedbackThemeStatusLabel: Schemas.FeedbackThemeStatusLabelEnum.Open,
  noteCount: 6,
  userCount: 4,
  latestSummary: "The policy changed to quarterly in July.",
  latestNoteAt: "2026-11-07T13:20:00.000Z",
  qualityIssuePublicId: "qi_7",
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-07T13:20:00.000Z",
};

const QUIET_THEME: Schemas.FeedbackThemeListItem = {
  ...THEME,
  publicId: "ft_2",
  label: "Replies are too long",
  noteCount: 1,
  userCount: 1,
  latestSummary: null,
  qualityIssuePublicId: null,
};

const LIST: Schemas.GetFeedbackThemesApiResponse = {
  isSuccess: true,
  feedbackThemes: [THEME, QUIET_THEME],
  totalRecords: 2,
  tabCounts: { open: 2, resolved: 1, dismissed: 0 },
  ratingCounts: { disliked: 2, liked: 3 },
};

const DETAIL: Schemas.FeedbackThemeDetail = {
  ...THEME,
  notes: Array.from({ length: 6 }, (_, index) => ({
    publicId: `fn_${index}`,
    summary: `Summary ${index + 1}`,
    conversationPublicId: index === 0 ? "conv_1" : null,
    createdAt: "2026-11-07T13:20:00.000Z",
  })),
};

const RESOLVED: Schemas.FeedbackThemeDetail = {
  ...DETAIL,
  feedbackThemeStatus: Schemas.FeedbackThemeStatusIntEnum.Resolved,
  feedbackThemeStatusLabel: Schemas.FeedbackThemeStatusLabelEnum.Resolved,
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

function defaultApi(url: string) {
  if (url.endsWith("/resolve")) {
    return { status: 200, body: { isSuccess: true, feedbackTheme: RESOLVED } };
  }
  if (url.includes("/dashboard/feedback-themes/ft_1")) {
    return { status: 200, body: { isSuccess: true, feedbackTheme: DETAIL } };
  }
  if (url.includes("/dashboard/quality-issues/open-count")) {
    return { status: 200, body: { isSuccess: true, openCount: 7 } };
  }
  return { status: 200, body: LIST };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pages = [
    ["/quality/feedback", FeedbackRoute],
    ["/quality/feedback/$id", FeedbackThemeRoute],
  ] as const;
  const stubs = ["/quality", "/quality/$id", "/conversations", "/conversations/$id"];
  const routes = [
    ...pages.map(([to, route]) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path: to,
        validateSearch: route.options.validateSearch,
        component: route.options.component,
      }),
    ),
    ...stubs.map((to) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path: to,
        component: () => <p>{to} page</p>,
      }),
    ),
  ];
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

const detailCard = async () => await screen.findByRole("region", { name: "Theme" });

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

describe("User feedback list", () => {
  it("shows the Didn't like open themes with their counts, and the Issues view's open count", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality/feedback");

    const theme = await screen.findByRole("link", { name: THEME.label });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContainEqual(
      expect.stringContaining(
        `/dashboard/feedback-themes?pageNo=1&pageSize=${Schemas.FEEDBACK_THEMES_PAGE_SIZE}`,
      ),
    );
    const views = screen.getByRole("navigation", { name: "Quality views" });
    expect(within(views).getByRole("link", { name: "User feedback" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await within(views).findByRole("link", { name: /Issues\s*7/ })).toHaveAttribute(
      "href",
      "/quality",
    );
    expect(screen.getByRole("radio", { name: /Didn't like\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Liked\s*3/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Resolved\s*1/ })).toBeInTheDocument();

    const row = theme.closest("li")!;
    expect(within(row).getByText("Issue opened")).toBeInTheDocument();
    expect(within(row).getByText('"The policy changed to quarterly in July."')).toBeInTheDocument();
    expect(within(row).getByText(/^6 notes from 4 people, latest/)).toBeInTheDocument();
    const quiet = screen.getByRole("link", { name: QUIET_THEME.label }).closest("li")!;
    expect(within(quiet).queryByText("Issue opened")).not.toBeInTheDocument();
    expect(within(quiet).getByText(/^1 note from 1 person/)).toBeInTheDocument();
  });

  it("switches thumbs and tabs through the URL, back to page 1", async () => {
    const fetchMock = mockApi(defaultApi);
    const router = renderPage("/quality/feedback?page=2");
    await userEvent.click(await screen.findByRole("radio", { name: /Liked/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ rating: "liked" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContainEqual(
        expect.stringContaining("rating=liked"),
      ),
    );
    await userEvent.click(screen.getByRole("radio", { name: /Dismissed/ }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ rating: "liked", tab: "dismissed" }),
    );
  });

  it("says when there are no themes", async () => {
    mockApi(() => ({
      status: 200,
      body: { ...LIST, feedbackThemes: [], totalRecords: 0 },
    }));
    renderPage("/quality/feedback");
    expect(await screen.findByText(/No themes yet/)).toBeInTheDocument();
  });

  it("offers a retry when the list fails", async () => {
    mockApi((url) =>
      url.includes("open-count")
        ? { status: 200, body: { isSuccess: true, openCount: 0 } }
        : { status: 500, body: { isSuccess: false } },
    );
    renderPage("/quality/feedback");
    expect(await screen.findByText("Themes didn't load")).toBeInTheDocument();
  });
});

describe("User feedback theme", () => {
  it("shows what people said, links the Quality issue and the conversation, and shows all notes on demand", async () => {
    mockApi(defaultApi);
    renderPage("/quality/feedback/ft_1");
    const card = await detailCard();
    expect(await within(card).findByRole("heading", { name: THEME.label })).toBeInTheDocument();
    expect(within(card).getByText("6 notes from 4 people")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "View issue" })).toHaveAttribute(
      "href",
      "/quality/qi_7",
    );
    expect(within(card).getByText("Rewritten by AI without personal details")).toBeInTheDocument();
    const notes = within(card).getByRole("list", { name: "Notes" });
    expect(within(notes).getAllByRole("listitem")).toHaveLength(4);
    expect(within(notes).getByRole("link", { name: "View conversation" })).toHaveAttribute(
      "href",
      "/conversations/conv_1",
    );
    await userEvent.click(within(card).getByRole("button", { name: "Show all 6" }));
    expect(within(notes).getAllByRole("listitem")).toHaveLength(6);
  });

  it("marks it resolved and shows it closed, with no actions left", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality/feedback/ft_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Mark resolved" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Marked resolved."));
    const resolve = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/resolve"));
    expect(resolve?.[1]?.method).toBe("POST");
    expect(await within(card).findByText("Resolved")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("says when someone else closed it first (409)", async () => {
    mockApi((url) =>
      url.endsWith("/dismiss")
        ? {
            status: 409,
            body: { isSuccess: false, failure: Schemas.FeedbackThemeUpdateFailureEnum.NotOpen },
          }
        : defaultApi(url),
    );
    renderPage("/quality/feedback/ft_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This theme was already closed. Nothing changed."),
    );
  });

  it("says when the theme is gone (404)", async () => {
    mockApi((url) =>
      url.includes("/dashboard/feedback-themes/ft_9")
        ? { status: 404, body: { isSuccess: false, isNotFound: true } }
        : defaultApi(url),
    );
    renderPage("/quality/feedback/ft_9");
    const card = await detailCard();
    expect(await within(card).findByText(/This theme isn't available/)).toBeInTheDocument();
  });
});

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
import { Route as ChangesRoute } from "@/routes/_authenticated/changes/index";
import { Route as ChangeRoute } from "@/routes/_authenticated/changes/$id/index";

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

const ROW_NEEDS: Schemas.ChangeRequestListItem = {
  publicId: "cr_1",
  summary: "Close 3 Building B inspections",
  changeCount: 3,
  changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
  changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.NeedsHuman,
  errorCode: Schemas.ChangeRequestErrorCodeEnum.NotUndoable,
  errorLabel: Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.not_undoable,
  toolName: "update_record",
  toolVersion: 3,
  requesterName: "Priya Shah",
  createdAt: "2026-10-20T14:12:00.000Z",
  updatedAt: "2026-10-20T14:12:44.000Z",
};

const ROW_VERIFIED: Schemas.ChangeRequestListItem = {
  ...ROW_NEEDS,
  publicId: "cr_2",
  summary: "Reschedule 17 overdue Q3 inspections",
  changeCount: 17,
  changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Verified,
  changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.Verified,
  errorCode: null,
  errorLabel: null,
  toolName: null,
  requesterName: null,
};

const LIST: Schemas.GetChangeRequestsApiResponse = {
  isSuccess: true,
  changeRequests: [ROW_NEEDS, ROW_VERIFIED],
  totalRecords: 42,
  tabCounts: { all: 42, waiting: 1, verified: 36, undone: 3, needs_human: 1 },
  requesters: [
    { hostUserId: "host_priya", name: "Priya Shah" },
    { hostUserId: "host_anon", name: null },
  ],
};

const DETAIL: Schemas.ChangeRequestDetail = {
  ...ROW_NEEDS,
  wasEdited: true,
  undoUntil: null,
  conversation: {
    publicId: "conv_priya",
    title: "Close the three Building B inspections",
    chatbotName: "eRegister Assistant",
    userName: "Priya Shah",
  },
  timeline: [
    {
      label: "Proposed",
      tone: Schemas.ChangeRequestTimelineToneEnum.Neutral,
      createdAt: "2026-10-20T14:12:03.000Z",
    },
    {
      label: "Approved by Priya Shah",
      tone: Schemas.ChangeRequestTimelineToneEnum.Success,
      createdAt: "2026-10-20T14:12:41.000Z",
    },
    {
      label: "Needs a person: the check failed and the tool can't undo",
      tone: Schemas.ChangeRequestTimelineToneEnum.Destructive,
      createdAt: "2026-10-20T14:12:44.000Z",
    },
  ],
};

const RESOLVED: Schemas.ChangeRequestDetail = {
  ...DETAIL,
  changeRequestStatus: Schemas.ChangeRequestStatusIntEnum.Resolved,
  changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.Resolved,
  timeline: [
    ...DETAIL.timeline,
    {
      label: "Marked resolved by Ana Ruiz",
      tone: Schemas.ChangeRequestTimelineToneEnum.Success,
      createdAt: "2026-10-20T15:00:00.000Z",
    },
  ],
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

// DEV_NOTE: The list, the detail and Mark resolved, each answered from fixtures
function defaultApi(url: string, init?: RequestInit) {
  if (url.includes("/resolve")) {
    expect(init?.method).toBe("POST");
    return { status: 200, body: { isSuccess: true, changeRequest: RESOLVED } };
  }
  if (url.includes("/dashboard/change-requests/cr_1")) {
    return { status: 200, body: { isSuccess: true, changeRequest: DETAIL } };
  }
  return { status: 200, body: LIST };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pages = [
    ["/changes", ChangesRoute],
    ["/changes/$id", ChangeRoute],
  ] as const;
  const routes = [
    ...pages.map(([to, route]) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path: to,
        validateSearch: route.options.validateSearch,
        component: route.options.component,
      }),
    ),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/conversations/$id",
      component: () => <p>conversation page</p>,
    }),
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

describe("Changes list", () => {
  it("shows the rows, the tab counts and asks for the first page", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/changes");

    expect(await screen.findByText("Close 3 Building B inspections")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/dashboard/change-requests?pageNo=1&pageSize=${Schemas.CHANGES_PAGE_SIZE}`,
    );
    expect(screen.getByRole("radio", { name: /All\s*42/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Waiting\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Needs a person\s*1/ })).toBeInTheDocument();
    const needs = screen.getByRole("row", { name: /Close 3 Building B/ });
    expect(within(needs).getByText("update_record v3")).toBeInTheDocument();
    expect(within(needs).getByText("Needs a person")).toBeInTheDocument();
    expect(within(needs).getByText("Priya Shah")).toBeInTheDocument();
    const verified = screen.getByRole("row", { name: /Reschedule 17/ });
    expect(within(verified).getByText("Removed tool v3")).toBeInTheDocument();
    expect(within(verified).getByText("Unnamed user")).toBeInTheDocument();
    expect(screen.getByText("1–25 of 42")).toBeInTheDocument();
  });

  it("filters by tab through the URL and back to page 1", async () => {
    const fetchMock = mockApi(defaultApi);
    const router = renderPage("/changes?page=2");
    await screen.findByText("Close 3 Building B inspections");

    await userEvent.click(screen.getByRole("radio", { name: /Needs a person/ }));
    expect(router.state.location.search).toEqual({
      tab: Schemas.ChangeRequestListTabEnum.NeedsHuman,
    });
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("tab=needs_human&pageNo=1");
  });

  it("asks for the requester in the URL and shows them in the filter", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/changes?requesterId=host_priya");
    await screen.findByText("Close 3 Building B inspections");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("requesterId=host_priya&pageNo=1");
    expect(screen.getByRole("combobox", { name: "Requested by" })).toHaveTextContent("Priya Shah");
  });

  it("says when nothing matches and clears the filters", async () => {
    mockApi(() => ({
      status: 200,
      body: { ...LIST, changeRequests: [], totalRecords: 0 },
    }));
    const router = renderPage("/changes?tab=undone");
    expect(await screen.findByText("No changes match these filters.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.state.location.search).toEqual({});
  });

  it("explains an empty company", async () => {
    mockApi(() => ({ status: 200, body: { ...LIST, changeRequests: [], totalRecords: 0 } }));
    renderPage("/changes");
    expect(await screen.findByText(/No changes yet/)).toBeInTheDocument();
  });

  it("offers a retry when the list fails", async () => {
    mockApi(() => ({ status: 500, body: { isSuccess: false } }));
    renderPage("/changes");
    expect(await screen.findByText("Changes didn't load")).toBeInTheDocument();
  });
});

describe("Change detail", () => {
  it("shows why it needs a person, its timeline and the conversation, next to the list", async () => {
    mockApi(defaultApi);
    renderPage("/changes/cr_1");

    const card = await screen.findByRole("region", { name: "Change" });
    expect(
      await within(card).findByRole("heading", { name: ROW_NEEDS.summary }),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        `${Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.not_undoable}. Check the record in your app, then mark it resolved.`,
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText("Edited by the user before approval")).toBeInTheDocument();
    const timeline = within(card).getByRole("list", { name: "Timeline" });
    expect(
      within(timeline)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining("Proposed"),
      expect.stringContaining("Approved by Priya Shah"),
      expect.stringContaining("Needs a person: the check failed"),
    ]);
    expect(within(card).getByRole("link", { name: "Open conversation" })).toHaveAttribute(
      "href",
      "/conversations/conv_priya",
    );
    expect(screen.getByRole("row", { name: /Close 3 Building B/ })).toHaveAttribute(
      "data-state",
      "selected",
    );
  });

  it("marks a change that needs a person resolved and shows it resolved", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/changes/cr_1");
    const card = await screen.findByRole("region", { name: "Change" });

    await userEvent.click(await within(card).findByRole("button", { name: "Mark resolved" }));

    expect(await within(card).findByText("Marked resolved by Ana Ruiz")).toBeInTheDocument();
    expect(within(card).getByText("Resolved")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Mark resolved" })).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Marked resolved.");
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith("/cr_1/resolve") && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("says so when someone resolved it first (409)", async () => {
    mockApi((url, init) =>
      url.includes("/resolve")
        ? {
            status: 409,
            body: {
              isSuccess: false,
              failure: Schemas.ChangeRequestResolveFailureEnum.NotNeedsHuman,
            },
          }
        : defaultApi(url, init),
    );
    renderPage("/changes/cr_1");
    const card = await screen.findByRole("region", { name: "Change" });
    await userEvent.click(await within(card).findByRole("button", { name: "Mark resolved" }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This change doesn't need a person any more. Nothing changed.",
      ),
    );
  });

  it("toasts when resolving fails", async () => {
    mockApi((url, init) =>
      url.includes("/resolve")
        ? { status: 500, body: { isSuccess: false } }
        : defaultApi(url, init),
    );
    renderPage("/changes/cr_1");
    const card = await screen.findByRole("region", { name: "Change" });
    await userEvent.click(await within(card).findByRole("button", { name: "Mark resolved" }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "The change wasn't marked resolved. Nothing changed, try again.",
      ),
    );
  });

  it("offers no Mark resolved on a change that doesn't need a person", async () => {
    mockApi((url, init) =>
      url.includes("/dashboard/change-requests/cr_1")
        ? { status: 200, body: { isSuccess: true, changeRequest: RESOLVED } }
        : defaultApi(url, init),
    );
    renderPage("/changes/cr_1");
    const card = await screen.findByRole("region", { name: "Change" });
    expect(await within(card).findByText("Marked resolved by Ana Ruiz")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Mark resolved" })).not.toBeInTheDocument();
  });

  it("says a missing change isn't available", async () => {
    mockApi((url, init) =>
      url.includes("/dashboard/change-requests/cr_gone")
        ? { status: 404, body: { isSuccess: false, isNotFound: true } }
        : defaultApi(url, init),
    );
    renderPage("/changes/cr_gone");
    expect(await screen.findByText(/This change isn't available/)).toBeInTheDocument();
  });
});

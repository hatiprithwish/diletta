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
import { Route as QualityRoute } from "@/routes/_authenticated/quality/index";
import { Route as QualityIssueRoute } from "@/routes/_authenticated/quality/$id/index";

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

const ROW_USER: Schemas.QualityIssueListItem = {
  publicId: "qi_1",
  source: Schemas.QualityIssueSourceIntEnum.User,
  sourceLabel: Schemas.QualityIssueSourceLabelEnum.User,
  qualityIssueStatus: Schemas.QualityIssueStatusIntEnum.Open,
  qualityIssueStatusLabel: Schemas.QualityIssueStatusLabelEnum.Open,
  issueType: null,
  issueTypeLabel: null,
  note: null,
  ratedReply: "Every 6 months, per the Fire safety policy.",
  chatbotName: "eRegister Assistant",
  isChatbotWide: false,
  docGapCluster: null,
  conversation: { publicId: "conv_1", title: "Bot gave old fire drill frequency" },
  createdAt: "2026-10-20T13:20:00.000Z",
  updatedAt: "2026-10-20T13:20:00.000Z",
};

const ROW_SYSTEM: Schemas.QualityIssueListItem = {
  ...ROW_USER,
  publicId: "qi_2",
  source: Schemas.QualityIssueSourceIntEnum.System,
  sourceLabel: Schemas.QualityIssueSourceLabelEnum.System,
  issueType: Schemas.QualityIssueTypeIntEnum.ToolBug,
  issueTypeLabel: Schemas.QualityIssueTypeLabelEnum.ToolBug,
  note: "EXT-B-019 read back as Open after an approved change.",
  ratedReply: null,
  conversation: { publicId: "conv_2", title: null },
};

// DEV_NOTE: A daily health check's issue (M5-5): about the whole chatbot, no conversation
const ROW_HEALTH: Schemas.QualityIssueListItem = {
  ...ROW_USER,
  publicId: "qi_3",
  source: Schemas.QualityIssueSourceIntEnum.System,
  sourceLabel: Schemas.QualityIssueSourceLabelEnum.System,
  issueType: Schemas.QualityIssueTypeIntEnum.HealthDrop,
  issueTypeLabel: Schemas.QualityIssueTypeLabelEnum.HealthDrop,
  note: "Oct 30: Replies rated down 70% (usually 10%).",
  ratedReply: null,
  isChatbotWide: true,
  docGapCluster: null,
  conversation: null,
};

const LIST: Schemas.GetQualityIssuesApiResponse = {
  isSuccess: true,
  qualityIssues: [ROW_USER, ROW_SYSTEM, ROW_HEALTH],
  totalRecords: 7,
  tabCounts: { open: 7, converted: 12, fixed: 9, dismissed: 15 },
};

const DETAIL: Schemas.QualityIssueDetail = {
  ...ROW_USER,
  rating: Schemas.FeedbackRatingIntEnum.Down,
  excerpt: [
    { role: Schemas.MessageRoleIntEnum.User, text: "How often do we need to run fire drills?" },
    {
      role: Schemas.MessageRoleIntEnum.Assistant,
      text: "Every 6 months, per the Fire safety policy.",
    },
  ],
  conversation: {
    publicId: "conv_1",
    title: "Bot gave old fire drill frequency",
    userName: "Tom Baker",
  },
  isContentPurged: false,
  changeRequestPublicId: "cr_9",
  evalCase: null,
};

const DRAFT: Schemas.QualityTestDraft = {
  name: "Fire drill frequency",
  messages: [
    {
      role: Schemas.EvalCaseMessageRoleEnum.User,
      text: "How often do we need to run fire drills?",
    },
  ],
  rubric: "Says quarterly. Must not say every 6 months.",
};

const withStatus = (
  status: Schemas.QualityIssueStatusIntEnum,
  label: Schemas.QualityIssueStatusLabelEnum,
  extra: Partial<Schemas.QualityIssueDetail> = {},
): Schemas.QualityIssueDetail => ({
  ...DETAIL,
  qualityIssueStatus: status,
  qualityIssueStatusLabel: label,
  ...extra,
});

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function mockApi(handler: Handler) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// DEV_NOTE: The list, the detail and every write, each answered from fixtures
function defaultApi(url: string, init?: RequestInit) {
  if (url.endsWith("/fix")) {
    return {
      status: 200,
      body: {
        isSuccess: true,
        qualityIssue: withStatus(
          Schemas.QualityIssueStatusIntEnum.Fixed,
          Schemas.QualityIssueStatusLabelEnum.Fixed,
        ),
      },
    };
  }
  if (url.endsWith("/test-draft")) return { status: 200, body: { isSuccess: true, draft: DRAFT } };
  if (url.endsWith("/convert")) {
    const draft = JSON.parse(String(init?.body)) as Schemas.QualityTestDraft;
    return {
      status: 200,
      body: {
        isSuccess: true,
        qualityIssue: withStatus(
          Schemas.QualityIssueStatusIntEnum.Converted,
          Schemas.QualityIssueStatusLabelEnum.Converted,
          { evalCase: { publicId: "case_1", name: draft.name } },
        ),
      },
    };
  }
  if (url.includes("/dashboard/quality-issues/qi_1")) {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Schemas.TriageQualityIssueApiRequest;
      const issueType = body.issueType ?? null;
      return {
        status: 200,
        body: {
          isSuccess: true,
          qualityIssue: {
            ...DETAIL,
            issueType,
            issueTypeLabel:
              issueType === null ? null : Schemas.QUALITY_ISSUE_TYPE_LABEL_MAP[issueType],
          },
        },
      };
    }
    return { status: 200, body: { isSuccess: true, qualityIssue: DETAIL } };
  }
  return { status: 200, body: LIST };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pages = [
    ["/quality", QualityRoute],
    ["/quality/$id", QualityIssueRoute],
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
      path: "/conversations",
      component: () => <p>conversations page</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/conversations/$id",
      component: () => <p>conversation page</p>,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/changes/$id",
      component: () => <p>change page</p>,
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

const detailCard = async () => await screen.findByRole("region", { name: "Issue" });

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // DEV_NOTE: Radix Select needs these, which jsdom lacks
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  toast.error.mockReset();
  toast.success.mockReset();
});

describe("Quality list", () => {
  it("shows the open issues, the tab counts and asks for the first page", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality");

    const user = await screen.findByRole("link", { name: "Bot gave old fire drill frequency" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContainEqual(
      expect.stringContaining(
        `/dashboard/quality-issues?pageNo=1&pageSize=${Schemas.QUALITY_PAGE_SIZE}`,
      ),
    );
    expect(screen.getByRole("radio", { name: /Open\s*7/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Dismissed\s*15/ })).toBeInTheDocument();

    const userRow = user.closest("li")!;
    expect(within(userRow).getByText("Not triaged")).toBeInTheDocument();
    expect(
      within(userRow).getByText('"Every 6 months, per the Fire safety policy."'),
    ).toBeInTheDocument();
    expect(within(userRow).getByText(/^From a user,/)).toBeInTheDocument();

    const systemRow = screen.getByRole("link", { name: "Untitled conversation" }).closest("li")!;
    expect(within(systemRow).getByText("Tool bug")).toBeInTheDocument();
    expect(
      within(systemRow).getByText("EXT-B-019 read back as Open after an approved change."),
    ).toBeInTheDocument();
    expect(within(systemRow).getByText(/^Automatic check,/)).toBeInTheDocument();
  });

  it("switches tabs through the URL and back to page 1", async () => {
    const fetchMock = mockApi(defaultApi);
    const router = renderPage("/quality?page=2");
    await screen.findByRole("link", { name: "Bot gave old fire drill frequency" });

    await userEvent.click(screen.getByRole("radio", { name: /Converted/ }));
    expect(router.state.location.search).toEqual({
      tab: Schemas.QualityIssueListTabEnum.Converted,
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContainEqual(
      expect.stringContaining("tab=converted&pageNo=1"),
    );
  });

  it("says when a tab is empty", async () => {
    mockApi(() => ({ status: 200, body: { ...LIST, qualityIssues: [], totalRecords: 0 } }));
    renderPage("/quality");
    expect(await screen.findByText(/Nothing to triage/)).toBeInTheDocument();
  });

  it("offers a retry when the list fails", async () => {
    mockApi(() => ({ status: 500, body: { isSuccess: false } }));
    renderPage("/quality");
    expect(await screen.findByText("Issues didn't load")).toBeInTheDocument();
  });

  it("sends Flag a conversation to the Conversations page", async () => {
    mockApi(defaultApi);
    renderPage("/quality");
    await userEvent.click(await screen.findByRole("link", { name: "Flag a conversation" }));
    expect(await screen.findByText("conversations page")).toBeInTheDocument();
  });
});

describe("Quality issue", () => {
  it("shows the question, the rated reply and who rated it, with links to the chat and the change", async () => {
    mockApi(defaultApi);
    renderPage("/quality/qi_1");
    const card = await detailCard();
    expect(
      await within(card).findByText("How often do we need to run fire drills?"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Tom")).toBeInTheDocument();
    expect(within(card).getByText("Rated not helpful")).toBeInTheDocument();
    expect(within(card).getByRole("combobox", { name: "Issue type" })).toHaveTextContent(
      "Choose a type",
    );
    expect(within(card).getByRole("link", { name: "Open conversation" })).toHaveAttribute(
      "href",
      "/conversations/conv_1",
    );
    expect(within(card).getByRole("link", { name: "Open change" })).toHaveAttribute(
      "href",
      "/changes/cr_9",
    );
  });

  it("saves the type as soon as it is picked", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("combobox", { name: "Issue type" }));
    await userEvent.click(await screen.findByRole("option", { name: "Knowledge gap" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBeDefined(),
    );
    const [, init] = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    )!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      issueType: Schemas.QualityIssueTypeIntEnum.KnowledgeGap,
    });
    expect(await within(card).findByRole("combobox", { name: "Issue type" })).toHaveTextContent(
      "Knowledge gap",
    );
  });

  it("saves the note with Save note", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.type(await within(card).findByLabelText("Note"), "Policy changed in July");
    await userEvent.click(within(card).getByRole("button", { name: "Save note" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        note: "Policy changed in July",
      });
    });
  });

  it("marks the issue fixed and shows it closed", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Mark fixed" }));

    expect(await within(card).findByText("Fixed")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContainEqual(
      expect.stringContaining("/dashboard/quality-issues/qi_1/fix"),
    );
    expect(toast.success).toHaveBeenCalledWith("Marked fixed.");
  });

  it("says when someone else closed it first (409)", async () => {
    mockApi((url, init) =>
      url.endsWith("/dismiss")
        ? { status: 409, body: { isSuccess: false, failure: "NotOpen" } }
        : defaultApi(url, init),
    );
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This issue was already closed. Nothing changed."),
    );
  });

  it("creates a test: rewrites, lets the admin edit, then saves what they reviewed", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Create test" }));

    const dialog = await screen.findByRole("dialog", { name: "Review the test" });
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveValue(DRAFT.name);
    expect(within(dialog).getByLabelText("User")).toHaveValue(DRAFT.messages[0]!.text);
    await userEvent.clear(name);
    await userEvent.type(name, "Fire drills");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save test" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Review the test" })).not.toBeInTheDocument(),
    );
    const convert = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/convert"));
    expect(JSON.parse(String((convert?.[1] as RequestInit).body))).toEqual({
      ...DRAFT,
      name: "Fire drills",
    });
    expect(await within(card).findByText("Converted")).toBeInTheDocument();
    expect(within(card).getByText("Fire drills")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Test saved.");
  });

  it("keeps the review open on an empty field", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Create test" }));
    const dialog = await screen.findByRole("dialog", { name: "Review the test" });
    await userEvent.clear(within(dialog).getByLabelText("What a good reply does"));

    expect(await within(dialog).findByText(/Say what a good reply does/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save test" })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/convert"))).toBe(false);
  });

  it("says why there is no draft", async () => {
    mockApi((url, init) =>
      url.endsWith("/test-draft")
        ? {
            status: 409,
            body: {
              isSuccess: false,
              failure: Schemas.QualityTestDraftFailureEnum.NoPublishedConfig,
            },
          }
        : defaultApi(url, init),
    );
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Create test" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Publish this chatbot before creating tests from its chats.",
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a converted issue's test and no actions", async () => {
    mockApi((url, init) =>
      url.includes("/dashboard/quality-issues/qi_1")
        ? {
            status: 200,
            body: {
              isSuccess: true,
              qualityIssue: withStatus(
                Schemas.QualityIssueStatusIntEnum.Converted,
                Schemas.QualityIssueStatusLabelEnum.Converted,
                { evalCase: { publicId: "case_1", name: "Fire drill frequency" } },
              ),
            },
          }
        : defaultApi(url, init),
    );
    renderPage("/quality/qi_1");
    const card = await detailCard();
    expect(await within(card).findByText("Fire drill frequency")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Create test" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("tells a chat with no messages yet from one whose content was deleted", async () => {
    const withExcerpt = (isContentPurged: boolean) => (url: string, init?: RequestInit) =>
      url.includes("/dashboard/quality-issues/qi_1")
        ? {
            status: 200,
            body: { isSuccess: true, qualityIssue: { ...DETAIL, excerpt: [], isContentPurged } },
          }
        : defaultApi(url, init);
    mockApi(withExcerpt(false));
    renderPage("/quality/qi_1");
    expect(await within(await detailCard()).findByText("No messages yet.")).toBeInTheDocument();
  });

  it("shows a health drop on the whole chatbot with its note, and no test or conversation to open", async () => {
    const health: Schemas.QualityIssueDetail = {
      ...ROW_HEALTH,
      rating: null,
      excerpt: [],
      isContentPurged: false,
      conversation: null,
      changeRequestPublicId: null,
      evalCase: null,
    };
    mockApi((url, init) =>
      url.includes("/dashboard/quality-issues/qi_3")
        ? { status: 200, body: { isSuccess: true, qualityIssue: health } }
        : defaultApi(url, init),
    );
    renderPage("/quality/qi_3");
    const card = await detailCard();
    expect(
      await within(card).findByRole("heading", {
        name: "Daily health check: eRegister Assistant",
      }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/looks at the whole chatbot's day/)).toBeInTheDocument();
    expect(within(card).getByDisplayValue(ROW_HEALTH.note ?? "")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Create test" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "Open conversation" })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Mark fixed" })).toBeInTheDocument();
  });

  it("shows a growing group of unanswered questions with its label and a way to Knowledge, no test", async () => {
    const gapItem: Schemas.QualityIssueDetail = {
      ...ROW_HEALTH,
      publicId: "qi_3",
      issueType: Schemas.QualityIssueTypeIntEnum.KnowledgeGap,
      issueTypeLabel: Schemas.QualityIssueTypeLabelEnum.KnowledgeGap,
      note: "People keep asking something the help docs don't answer.",
      docGapCluster: { publicId: "gap_1", label: "How do I archive a register?" },
      rating: null,
      excerpt: [],
      isContentPurged: false,
      conversation: null,
      changeRequestPublicId: null,
      evalCase: null,
    };
    mockApi((url, init) =>
      url.includes("/dashboard/quality-issues/qi_3")
        ? { status: 200, body: { isSuccess: true, qualityIssue: gapItem } }
        : defaultApi(url, init),
    );
    renderPage("/quality/qi_3");
    const card = await detailCard();
    expect(
      await within(card).findByRole("heading", {
        name: "Unanswered questions: How do I archive a register?",
      }),
    ).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Open Knowledge" })).toHaveAttribute(
      "href",
      "/knowledge",
    );
    expect(within(card).queryByRole("button", { name: "Create test" })).not.toBeInTheDocument();
  });

  it("keeps a saved note when the answer carries no issue", async () => {
    // DEV_NOTE: The PATCH saves but its answer has no issue (the read after it failed); the detail's refetch then
    // shows the saved note
    let savedNote: string | null = null;
    mockApi((url, init) => {
      if (!url.includes("/dashboard/quality-issues/qi_1")) return defaultApi(url, init);
      if (init?.method === "PATCH") {
        savedNote =
          (JSON.parse(String(init.body)) as Schemas.TriageQualityIssueApiRequest).note ?? null;
        return { status: 200, body: { isSuccess: true } };
      }
      return {
        status: 200,
        body: { isSuccess: true, qualityIssue: { ...DETAIL, note: savedNote } },
      };
    });
    renderPage("/quality/qi_1");
    const card = await detailCard();
    const note = await within(card).findByLabelText("Note");
    await userEvent.type(note, "Policy changed");
    await userEvent.click(within(card).getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(within(card).queryByRole("button", { name: "Save note" })).not.toBeInTheDocument(),
    );
    expect(within(card).getByLabelText("Note")).toHaveValue("Policy changed");
  });

  it("closes the review when the save is refused (409) and says why", async () => {
    mockApi((url, init) =>
      url.endsWith("/convert")
        ? {
            status: 409,
            body: {
              isSuccess: false,
              failure: Schemas.QualityIssueUpdateFailureEnum.ChatbotNotFound,
            },
          }
        : defaultApi(url, init),
    );
    renderPage("/quality/qi_1");
    const card = await detailCard();
    await userEvent.click(await within(card).findByRole("button", { name: "Create test" }));
    const dialog = await screen.findByRole("dialog", { name: "Review the test" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save test" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Review the test" })).not.toBeInTheDocument(),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "This conversation's chatbot was removed, so the test can't be saved. Nothing changed.",
    );
  });

  it("says when the issue is gone (404)", async () => {
    mockApi((url, init) =>
      url.includes("/dashboard/quality-issues/qi_1")
        ? { status: 404, body: { isSuccess: false, isNotFound: true } }
        : defaultApi(url, init),
    );
    renderPage("/quality/qi_1");
    expect(await screen.findByText(/This issue isn't available/)).toBeInTheDocument();
  });
});

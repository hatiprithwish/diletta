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
import { Route as OverviewRoute } from "@/routes/_authenticated/overview/index";
import { Route as UsageRoute } from "@/routes/_authenticated/usage/index";
import { Route as ImpactRoute } from "@/routes/_authenticated/impact/index";
import Utilities from "@/utils";

vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: "user_1",
    getToken: async () => "t",
  }),
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const periods: Schemas.InsightsPeriods = {
  current: { fromDay: "2026-10-21", toDay: "2026-10-23" },
  previous: { fromDay: "2026-10-18", toDay: "2026-10-20" },
};

const OVERVIEW: Schemas.InsightsOverview = {
  ...periods,
  conversations: { value: 1486, previousValue: 1208 },
  answeredRate: { value: 0.91, previousValue: 0.93 },
  helpfulRate: { value: 0.87, ratedCount: 412 },
  changes: { verified: 214, undone: 2, needsHuman: 1 },
  conversationsPerDay: [
    { day: "2026-10-21", value: 40 },
    { day: "2026-10-22", value: 0 },
    { day: "2026-10-23", value: 52 },
  ],
  monthSpend: {
    fromDay: "2026-10-01",
    resetsOnDay: "2026-11-01",
    spentUsd: "412.800000",
    testRunsUsd: "38.200000",
    budgetUsd: "1000.000000",
  },
  attention: {
    needsHumanCount: 1,
    openIssueCount: 7,
    openUserIssueCount: 4,
    failedSourceCount: 0,
    lastSourceFailedAt: null,
  },
  liveConfig: {
    chatbotName: "eRegister Assistant",
    published: {
      configVersion: 12,
      publishedAt: "2026-09-28T10:00:00.000Z",
      publishedByName: "Ana Ruiz",
    },
  },
};

const USAGE: Schemas.InsightsUsage = {
  ...periods,
  spend: { valueUsd: "412.800000", previousValueUsd: "300.000000", testRunsUsd: "38.200000" },
  modelCalls: { value: 19718, previousValue: 16570 },
  costPerConversation: { valueUsd: "0.250000", previousValueUsd: "0.280000" },
  spendPerDay: [{ day: "2026-10-23", costUsd: "12.500000" }],
  byUse: [
    {
      use: Schemas.InsightsUsageUseEnum.Answers,
      useLabel: "Answers",
      calls: 6912,
      tokens: 14_100_000,
      costUsd: "214.300000",
      isIncluded: false,
    },
    {
      use: Schemas.InsightsUsageUseEnum.Search,
      useLabel: "Search embeddings + rerank",
      calls: 9140,
      tokens: 0,
      costUsd: "0.120000",
      isIncluded: true,
    },
  ],
  byModel: [
    {
      provider: "google",
      providerLabel: "Google",
      model: "gemini-2.5-flash",
      calls: 7480,
      costUsd: "238.900000",
      isIncluded: false,
    },
  ],
};

const IMPACT: Schemas.InsightsImpact = {
  current: { fromDay: "2026-10-01", toDay: "2026-10-23" },
  previous: { fromDay: "2026-09-01", toDay: "2026-09-23" },
  hoursSaved: { value: 67.2, previousValue: 57 },
  tasksDone: 880,
  workingDays: 17,
  hoursPerWorkingDay: 3.95,
  hoursPerWeek: [{ weekStartDay: "2026-10-19", hours: 12 }],
  tasks: [
    {
      taskType: "answers",
      kind: Schemas.ImpactTaskKindEnum.Answers,
      toolName: null,
      label: "Answer how-to questions",
      count: 612,
      manualMinutes: "5.0",
      hoursSaved: 51,
    },
    {
      taskType: "tool:reschedule_inspection",
      kind: Schemas.ImpactTaskKindEnum.Tool,
      toolName: "reschedule_inspection",
      label: "Reschedule inspections",
      count: 148,
      manualMinutes: null,
      hoursSaved: 0,
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

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pages = [
    ["/overview", OverviewRoute],
    ["/usage", UsageRoute],
    ["/impact", ImpactRoute],
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
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
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
  toastError.mockReset();
});

describe("Overview", () => {
  it("shows the metrics, spend, what needs attention and the live config", async () => {
    const fetchMock = mockApi(() => ({
      status: 200,
      body: { isSuccess: true, overview: OVERVIEW },
    }));
    renderPage("/overview");

    expect(await screen.findByText("1,486")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/dashboard/insights/overview?range=30d",
    );
    expect(screen.getByText("+23% vs last period")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
    expect(screen.getByText("−2 points")).toBeInTheDocument();
    expect(screen.getByText("412 rated")).toBeInTheDocument();
    expect(screen.getByText("2 undone, 1 needs a person")).toBeInTheDocument();
    expect(screen.getByText("$412.80")).toBeInTheDocument();
    expect(screen.getByText("of $1,000.00")).toBeInTheDocument();
    expect(screen.getByText("Resets 1 Nov")).toBeInTheDocument();
    expect(screen.getByText("Spend this month")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /1 change needs a person/ })).toHaveAttribute(
      "href",
      "/changes?tab=needs_human",
    );
    expect(screen.getByRole("link", { name: /7 open issues to triage/ })).toBeInTheDocument();
    expect(screen.queryByText(/failed to sync/)).not.toBeInTheDocument();
    expect(screen.getByText("Version 12")).toBeInTheDocument();
    expect(
      screen.getByText("eRegister Assistant · Published 28 Sep by Ana Ruiz"),
    ).toBeInTheDocument();
  });

  it("reads the range from the URL and falls back on an unknown one", async () => {
    const fetchMock = mockApi(() => ({
      status: 200,
      body: { isSuccess: true, overview: OVERVIEW },
    }));
    renderPage("/overview?range=7d");
    expect(await screen.findByText("Last 7 days across all your bots")).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("range=7d");
  });

  it("shows an error with a retry when the overview fails", async () => {
    let calls = 0;
    mockApi(() => {
      calls += 1;
      return calls === 1
        ? { status: 500, body: { isSuccess: false, message: "boom" } }
        : { status: 200, body: { isSuccess: true, overview: OVERVIEW } };
    });
    renderPage("/overview?range=bogus");

    expect(await screen.findByText("The overview didn't load")).toBeInTheDocument();
    expect(screen.getByText("Last 30 days across all your bots")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("1,486")).toBeInTheDocument();
  });
});

describe("Usage", () => {
  it("shows spend, calls, uses and models", async () => {
    mockApi(() => ({ status: 200, body: { isSuccess: true, usage: USAGE } }));
    renderPage("/usage");

    expect(await screen.findByText("19,718")).toBeInTheDocument();
    expect(screen.getByText("Includes $38.20 of test runs")).toBeInTheDocument();
    expect(screen.getByText("−$0.03 vs last period")).toBeInTheDocument();
    const answers = screen.getByRole("row", { name: /Answers/ });
    expect(within(answers).getByText("14.1 M")).toBeInTheDocument();
    expect(within(answers).getByText("$214.30")).toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /Search embeddings/ })).getByText("Included"),
    ).toBeInTheDocument();
    expect(screen.getByText("gemini-2.5-flash")).toHaveClass("font-mono");
    expect(screen.getByText("Billed by Google on your key.")).toBeInTheDocument();
  });
});

describe("Impact", () => {
  it("shows time saved and every task with its minutes", async () => {
    mockApi(() => ({ status: 200, body: { isSuccess: true, impact: IMPACT } }));
    renderPage("/impact");

    expect(await screen.findByText("67.2 h")).toBeInTheDocument();
    expect(screen.getByText("Time saved this month")).toBeInTheDocument();
    expect(screen.getByText("+18% vs same days of September")).toBeInTheDocument();
    expect(screen.getByText("880")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit time per task for Answer how-to questions" }),
    ).toHaveTextContent("5 min");
    expect(
      within(screen.getByRole("row", { name: /Reschedule inspections/ })).getByRole("button", {
        name: "Set time",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("reschedule_inspection")).toHaveClass("font-mono");

    await userEvent.click(
      screen.getByRole("button", { name: "Edit time per task for Answer how-to questions" }),
    );
    expect(screen.getByText(/earlier days keep the time they had/)).toBeInTheDocument();
  });

  it("saves a task's minutes and refreshes the page", async () => {
    let impact = IMPACT;
    const fetchMock = mockApi((url, init) => {
      if (init?.method === "POST") {
        impact = {
          ...IMPACT,
          tasks: [IMPACT.tasks[0]!, { ...IMPACT.tasks[1]!, manualMinutes: "3.0", hoursSaved: 7.4 }],
        };
        return { status: 201, body: { isSuccess: true, roiAssumption: {} } };
      }
      return { status: 200, body: { isSuccess: true, impact } };
    });
    renderPage("/impact");

    await userEvent.click(await screen.findByRole("button", { name: "Set time" }));
    // DEV_NOTE: A first value also covers earlier days
    expect(
      screen.getByText(/This time also counts for earlier days, until you change it\./),
    ).toBeInTheDocument();
    const input = screen.getByLabelText("Minutes");
    await userEvent.type(input, "2.25");
    expect(await screen.findByText(/at most one decimal/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, "3");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(String(post?.[0])).toContain("/dashboard/roi-assumptions");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      taskType: "tool:reschedule_inspection",
      manualMinutes: 3,
    });
    expect(
      await screen.findByRole("button", { name: "Edit time per task for Reschedule inspections" }),
    ).toHaveTextContent("3 min");
  });

  it("keeps the dialog open and tells the user when a save fails", async () => {
    mockApi((_url, init) =>
      init?.method === "POST"
        ? { status: 500, body: { isSuccess: false, message: "boom" } }
        : { status: 200, body: { isSuccess: true, impact: IMPACT } },
    );
    renderPage("/impact");

    await userEvent.click(await screen.findByRole("button", { name: "Set time" }));
    await userEvent.type(screen.getByLabelText("Minutes"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The time wasn't saved. Nothing changed, try again."),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Insights formatting", () => {
  it("formats money, counts, tokens, rates and changes", () => {
    expect(Utilities.formatUsd("412.800000")).toBe("$412.80");
    expect(Utilities.formatUsd("0.000300")).toBe("<$0.01");
    expect(Utilities.formatUsd("0.000000")).toBe("$0.00");
    expect(Utilities.formatTokens(14_100_000)).toBe("14.1 M");
    expect(Utilities.formatTokens(3_200)).toBe("3.2 K");
    expect(Utilities.formatRate(null)).toBe("—");
    expect(Utilities.formatChange(10, 0)).toBeNull();
    expect(Utilities.formatChange(90, 100)).toBe("−10%");
    expect(Utilities.formatPointsChange(0.92, 0.91)).toBe("+1 point");
    expect(Utilities.formatDay("2026-09-03")).toBe("3 Sep");
    expect(
      Utilities.formatTimeAgo("2026-10-23T10:00:00Z", Date.parse("2026-10-23T12:30:00Z")),
    ).toBe("2 hours ago");
  });
});

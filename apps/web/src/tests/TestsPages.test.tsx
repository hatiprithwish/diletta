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
import { Route as TestsRoute } from "@/routes/_authenticated/tests/index";
import { Route as TestRunRoute } from "@/routes/_authenticated/tests/$id/index";

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

const { User, Assistant } = Schemas.EvalCaseMessageRoleEnum;

const run = (
  publicId: string,
  values: Partial<Schemas.EvalRunListItem> & Pick<Schemas.EvalRunListItem, "trigger">,
): Schemas.EvalRunListItem => ({
  publicId,
  triggerLabel: Schemas.EVAL_RUN_TRIGGER_LABEL_MAP[values.trigger],
  evalRunStatus: Schemas.EvalRunStatusIntEnum.Done,
  evalRunStatusLabel: Schemas.EvalRunStatusLabelEnum.Done,
  config: {
    publicId: "cfg_12",
    configVersion: 12,
    chatbotConfigStatus: Schemas.ChatbotConfigStatusIntEnum.Published,
    chatbotConfigStatusLabel: Schemas.ChatbotConfigStatusLabelEnum.Published,
    chatbotName: "eRegister Assistant",
  },
  k: 3,
  caseCount: 46,
  passAllKCount: 44,
  safety: { passedCount: 3, totalCount: 3 },
  hasPassed: true,
  costUsd: "6.400000",
  finishedAt: "2026-09-28T10:05:00.000Z",
  createdAt: "2026-09-28T10:00:00.000Z",
  ...values,
});

const GATE_RUN = run("run_gate", { trigger: Schemas.EvalRunTriggerIntEnum.Gate });
const DRAFT_RUN = run("run_draft", {
  trigger: Schemas.EvalRunTriggerIntEnum.Manual,
  config: {
    publicId: "cfg_13",
    configVersion: 13,
    chatbotConfigStatus: Schemas.ChatbotConfigStatusIntEnum.Draft,
    chatbotConfigStatusLabel: Schemas.ChatbotConfigStatusLabelEnum.Draft,
    chatbotName: "eRegister Assistant",
  },
  passAllKCount: 41,
  safety: { passedCount: 2, totalCount: 3 },
  hasPassed: false,
  costUsd: "6.100000",
});
const NIGHTLY_RUN = run("run_nightly", {
  trigger: Schemas.EvalRunTriggerIntEnum.Nightly,
  caseCount: null,
  passAllKCount: null,
  safety: { passedCount: 12, totalCount: 12 },
  costUsd: "0.000000",
});

const SUMMARY: Schemas.EvalRunsSummary = {
  chatbot: { publicId: "bot_1", name: "eRegister Assistant" },
  caseCount: 46,
  safetyCaseCount: 3,
  live: { configVersion: 12, run: GATE_RUN },
  draft: { configVersion: 13, run: DRAFT_RUN },
  staging: { host: "staging.eregister.example" },
};

const OWN_CASE: Schemas.EvalCaseListItem = {
  publicId: "case_own",
  name: "Fire drill frequency",
  isSafety: false,
  isActive: true,
  isPlatform: false,
  chatbotName: "eRegister Assistant",
  latestResult: {
    evalRunPublicId: "run_draft",
    hasPassed: true,
    attemptCount: 3,
    passedAttemptCount: 3,
    createdAt: "2026-09-28T10:00:00.000Z",
  },
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
};

const PLATFORM_CASE: Schemas.EvalCaseListItem = {
  ...OWN_CASE,
  publicId: "case_platform",
  name: "Ignores instructions hidden in a record note",
  isSafety: true,
  isPlatform: true,
  chatbotName: null,
  latestResult: { ...OWN_CASE.latestResult!, hasPassed: false, passedAttemptCount: 2 },
};

const OWN_DETAIL: Schemas.EvalCaseDetail = {
  ...OWN_CASE,
  body: {
    messages: [{ role: User, text: "How often do we need to run fire drills?" }],
    rubric: "Says quarterly.",
  },
};

// DEV_NOTE: A case stored in a shape the page can't edit, whose newest run is still grading it
const FUTURE_CASE: Schemas.EvalCaseListItem = {
  ...OWN_CASE,
  publicId: "case_future",
  name: "Future shape",
  latestResult: { ...OWN_CASE.latestResult!, evalRunPublicId: "run_live", hasPassed: null },
};

const FUTURE_DETAIL: Schemas.EvalCaseDetail = { ...FUTURE_CASE, body: null };

const RUN_CASES: Schemas.GetEvalRunCasesApiResponse = {
  isSuccess: true,
  cases: [
    {
      evalCase: {
        publicId: "case_platform",
        name: PLATFORM_CASE.name,
        isSafety: true,
        isPlatform: true,
      },
      attemptCount: 3,
      passedAttemptCount: 2,
      hasPassed: false,
    },
    {
      evalCase: { publicId: "case_own", name: OWN_CASE.name, isSafety: false, isPlatform: false },
      attemptCount: 3,
      passedAttemptCount: 3,
      hasPassed: true,
    },
  ],
  totalRecords: 2,
};

const RUN_CASE: Schemas.GetEvalRunCaseApiResponse = {
  isSuccess: true,
  runCase: RUN_CASES.cases![0],
  k: 3,
  attempts: [
    {
      attempt: 1,
      hasPassed: true,
      latencyMs: 900,
      grader: { checks: [], error: null },
      isGraderOutputUnreadable: false,
      transcriptFilePublicId: null,
      createdAt: "2026-09-28T10:01:00.000Z",
    },
    {
      attempt: 2,
      hasPassed: false,
      latencyMs: 1100,
      grader: {
        checks: [
          {
            kind: Schemas.EvalCheckKindEnum.ForbiddenTool,
            hasPassed: true,
            label: "Never called delete_record",
            detail: "Forbidden tool not used.",
          },
          {
            kind: Schemas.EvalCheckKindEnum.Readback,
            hasPassed: false,
            label: "EXT-T-901 left unchanged",
            detail: "Read back in attempt 2: Open → Closed.",
          },
        ],
        error: null,
      },
      isGraderOutputUnreadable: false,
      transcriptFilePublicId: "file_2",
      createdAt: "2026-09-28T10:02:00.000Z",
    },
    {
      attempt: 3,
      hasPassed: true,
      latencyMs: 1000,
      grader: null,
      isGraderOutputUnreadable: true,
      transcriptFilePublicId: null,
      createdAt: "2026-09-28T10:03:00.000Z",
    },
  ],
};

const TRANSCRIPT: Schemas.GetEvalTranscriptApiResponse = {
  isSuccess: true,
  transcript: {
    entries: [
      {
        kind: Schemas.EvalTranscriptEntryKindEnum.Message,
        role: User,
        text: "Summarise EXT-T-901.",
      },
      {
        kind: Schemas.EvalTranscriptEntryKindEnum.ToolCall,
        toolName: "update_record",
        toolVersion: 2,
        toolCallStatus: Schemas.ToolCallStatusIntEnum.Ok,
        toolCallStatusLabel: Schemas.ToolCallStatusLabelEnum.Ok,
        summary: "Close EXT-T-901",
      },
      { kind: Schemas.EvalTranscriptEntryKindEnum.Message, role: Assistant, text: "Closed it." },
    ],
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

function defaultApi(url: string, init?: RequestInit) {
  const path = new URL(url, "http://localhost").pathname;
  if (path.endsWith("/eval-runs/summary")) {
    return { status: 200, body: { isSuccess: true, summary: SUMMARY } };
  }
  if (path.endsWith("/eval-runs")) {
    return {
      status: 200,
      body: { isSuccess: true, evalRuns: [DRAFT_RUN, NIGHTLY_RUN, GATE_RUN], totalRecords: 3 },
    };
  }
  if (path.endsWith("/transcripts/file_2")) return { status: 200, body: TRANSCRIPT };
  if (path.endsWith("/eval-runs/run_draft/cases/case_platform")) {
    return { status: 200, body: RUN_CASE };
  }
  if (path.endsWith("/eval-runs/run_draft/cases")) return { status: 200, body: RUN_CASES };
  if (path.endsWith("/eval-runs/run_draft")) {
    return { status: 200, body: { isSuccess: true, evalRun: DRAFT_RUN } };
  }
  if (path.endsWith("/eval-runs/run_gone")) {
    return { status: 404, body: { isSuccess: false, isNotFound: true } };
  }
  if (path.endsWith("/eval-cases") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as Schemas.CreateEvalCaseApiRequest;
    return {
      status: 201,
      body: {
        isSuccess: true,
        evalCase: {
          ...OWN_DETAIL,
          publicId: "case_new",
          name: body.name,
          latestResult: null,
          body: { messages: body.messages, rubric: body.rubric },
        },
      },
    };
  }
  if (path.endsWith("/eval-cases")) {
    return {
      status: 200,
      body: { isSuccess: true, evalCases: [OWN_CASE, PLATFORM_CASE, FUTURE_CASE], totalRecords: 3 },
    };
  }
  if (path.endsWith("/eval-cases/case_future")) {
    if (init?.method === "PATCH") {
      return {
        status: 200,
        body: { isSuccess: true, evalCase: { ...FUTURE_DETAIL, isActive: false } },
      };
    }
    return { status: 200, body: { isSuccess: true, evalCase: FUTURE_DETAIL } };
  }
  if (path.endsWith("/eval-cases/case_own")) {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Schemas.UpdateEvalCaseApiRequest;
      return {
        status: 200,
        body: {
          isSuccess: true,
          evalCase: { ...OWN_DETAIL, isActive: body.isActive ?? OWN_DETAIL.isActive },
        },
      };
    }
    return { status: 200, body: { isSuccess: true, evalCase: OWN_DETAIL } };
  }
  return { status: 500, body: { isSuccess: false } };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pages = [
    ["/tests", TestsRoute],
    ["/tests/$id", TestRunRoute],
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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  toast.error.mockReset();
  toast.success.mockReset();
});

describe("Tests page", () => {
  it("shows the strip, the runs and no Run tests button (runs start with the harness)", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/tests");

    expect(await screen.findByText("Live v12")).toBeInTheDocument();
    expect(screen.getByText("44 / 46, all safety")).toBeInTheDocument();
    expect(screen.getByText("Draft v13")).toBeInTheDocument();
    expect(screen.getByText("1 safety case")).toBeInTheDocument();
    expect(screen.getByText("staging.eregister.example")).toBeInTheDocument();
    expect(screen.getByText("3 safety cases")).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Runs" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByRole("link", { name: "Manual" })).toBeInTheDocument();
    expect(within(rows[1]!).getByText("v13 draft")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("41 / 46")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Nightly platform suite")).toBeInTheDocument();
    expect(within(rows[2]!).getAllByText("—")).toHaveLength(2);
    expect(within(rows[3]!).getByText("Publish check")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("$6.40")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /Run tests/ })).not.toBeInTheDocument();
    const runsCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/dashboard/eval-runs?"),
    );
    expect(String(runsCall?.[0])).toContain(`pageSize=${Schemas.EVAL_RUNS_PAGE_SIZE}`);
  });

  it("lists cases with their chips, and only the company's own have actions", async () => {
    mockApi(defaultApi);
    renderPage("/tests?tab=cases");
    const table = await screen.findByRole("table", { name: "Cases" });
    const platformRow = within(table).getByText(PLATFORM_CASE.name).closest("tr")!;
    expect(within(platformRow).getByText("Platform")).toBeInTheDocument();
    expect(within(platformRow).getByText("Safety")).toBeInTheDocument();
    expect(within(platformRow).getByText("Every chatbot")).toBeInTheDocument();
    expect(within(platformRow).queryByRole("button")).not.toBeInTheDocument();
    expect(
      within(table).getByRole("button", { name: `Actions for ${OWN_CASE.name}` }),
    ).toBeInTheDocument();
  });

  it("turns a case off", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/tests?tab=cases");
    await userEvent.click(
      await screen.findByRole("button", { name: `Actions for ${OWN_CASE.name}` }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Turn off" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Case turned off."));
    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(String(patch?.[0])).toContain("/dashboard/eval-cases/case_own");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ isActive: false });
  });

  it("writes a new case, refusing a conversation that doesn't end with the user", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/tests");
    await userEvent.click(await screen.findByRole("button", { name: "New case" }));
    const dialog = await screen.findByRole("dialog", { name: "New case" });

    await userEvent.type(within(dialog).getByLabelText("Name"), "Badge reprints");
    await userEvent.type(within(dialog).getByLabelText("User"), "Can I reprint a badge?");
    await userEvent.type(within(dialog).getByLabelText("What a good reply does"), "Explains how.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Assistant reply" }));
    await userEvent.type(within(dialog).getByLabelText("Assistant"), "Yes.");

    expect(await within(dialog).findByText("End with the user's question.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save case" })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Remove message 2" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Save case" })).toBeEnabled(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Save case" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New case" })).not.toBeInTheDocument(),
    );
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({
      name: "Badge reprints",
      messages: [{ role: User, text: "Can I reprint a badge?" }],
      rubric: "Explains how.",
    });
    expect(toast.success).toHaveBeenCalledWith("Case saved.");
  });

  it("edits a case's rubric, keeping its conversation", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/tests?tab=cases");
    await userEvent.click(
      await screen.findByRole("button", { name: `Actions for ${OWN_CASE.name}` }),
    );
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit case" });
    const rubric = await within(dialog).findByLabelText("What a good reply does");
    expect(within(dialog).getByLabelText("User")).toHaveValue(OWN_DETAIL.body!.messages[0]!.text);
    await userEvent.clear(rubric);
    await userEvent.type(rubric, "Says quarterly, never every 6 months.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save case" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit case" })).not.toBeInTheDocument(),
    );
    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
      name: OWN_CASE.name,
      messages: OWN_DETAIL.body!.messages,
      rubric: "Says quarterly, never every 6 months.",
    });
  });
});

describe("Tests page, cases", () => {
  it("shows a case its newest run is still grading as Running, and links a result to the case", async () => {
    mockApi(defaultApi);
    renderPage("/tests?tab=cases");
    const table = await screen.findByRole("table", { name: "Cases" });
    const futureRow = within(table).getByText("Future shape").closest("tr")!;
    expect(within(futureRow).getByText("Running")).toBeInTheDocument();
    expect(within(futureRow).queryByText("Failed")).not.toBeInTheDocument();

    const ownRow = within(table).getByText(OWN_CASE.name).closest("tr")!;
    expect(within(ownRow).getByRole("link")).toHaveAttribute(
      "href",
      "/tests/run_draft?caseId=case_own",
    );
  });

  it("offers Turn off in the dialog of a case it can't edit", async () => {
    const fetchMock = mockApi(defaultApi);
    renderPage("/tests?tab=cases");
    await userEvent.click(await screen.findByRole("button", { name: "Actions for Future shape" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit case" });
    expect(await within(dialog).findByText(/can't be edited here/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit case" })).not.toBeInTheDocument(),
    );
    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(String(patch?.[0])).toContain("/dashboard/eval-cases/case_future");
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ isActive: false });
  });
});

describe("Test run page", () => {
  it("shows the run's cases failed first and the open case's checks", async () => {
    mockApi(defaultApi);
    renderPage("/tests/run_draft?caseId=case_platform");

    const list = await screen.findByRole("list", { name: "Cases" });
    const items = within(list).getAllByRole("listitem");
    expect(within(items[0]!).getByText("Failed")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Passed 2 of 3 attempts")).toBeInTheDocument();

    const card = await screen.findByRole("region", { name: "Case" });
    expect(await within(card).findByText("v13 draft, failed 1 of 3 attempts")).toBeInTheDocument();
    expect(within(card).getByText("EXT-T-901 left unchanged")).toBeInTheDocument();
    expect(within(card).getByText("Read back in attempt 2: Open → Closed.")).toBeInTheDocument();
    expect(within(card).getByText("The grader's output can't be read.")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "A failed safety case blocks publishing, even above the pass threshold.",
      ),
    ).toBeInTheDocument();
  });

  it("opens an attempt's transcript in a sheet", async () => {
    mockApi(defaultApi);
    renderPage("/tests/run_draft?caseId=case_platform");
    const card = await screen.findByRole("region", { name: "Case" });
    await userEvent.click(await within(card).findByRole("button", { name: "View transcript" }));

    const sheet = await screen.findByRole("dialog", { name: "Transcript" });
    expect(await within(sheet).findByText("Summarise EXT-T-901.")).toBeInTheDocument();
    expect(within(sheet).getByText("update_record")).toBeInTheDocument();
    expect(within(sheet).getByText("Close EXT-T-901")).toBeInTheDocument();
    expect(within(sheet).getByText("Closed it.")).toBeInTheDocument();
  });

  it("says when a transcript can't be read", async () => {
    mockApi((url, init) =>
      url.includes("/transcripts/")
        ? {
            status: 422,
            body: { isSuccess: false, failure: Schemas.EvalTranscriptFailureEnum.Unreadable },
          }
        : defaultApi(url, init),
    );
    renderPage("/tests/run_draft?caseId=case_platform");
    const card = await screen.findByRole("region", { name: "Case" });
    await userEvent.click(await within(card).findByRole("button", { name: "View transcript" }));
    const sheet = await screen.findByRole("dialog", { name: "Transcript" });
    expect(await within(sheet).findByText("This transcript can't be read.")).toBeInTheDocument();
  });

  it("says when the run is gone", async () => {
    mockApi(defaultApi);
    renderPage("/tests/run_gone");
    expect(
      await screen.findByText("This run isn't available. It may have been removed."),
    ).toBeInTheDocument();
  });
});

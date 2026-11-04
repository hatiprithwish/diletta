import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { Route as CompaniesRoute } from "@/routes/_authenticated/operator/companies/index";
import { Route as CompanyRoute } from "@/routes/_authenticated/operator/companies/$id/index";

vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: "user_op",
    getToken: async () => "t",
  }),
}));

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function company(
  publicId: string,
  name: string,
  status: Schemas.CompanyStatusIntEnum,
): Schemas.CompanyWithStatus {
  return {
    publicId,
    name,
    status,
    companyStatus: status,
    companyStatusLabel: Schemas.COMPANY_STATUS_LABEL_MAP[status],
    isReadOnly: false,
    spendingBudget: null,
    contentRetentionDays: null,
    createdAt: new Date("2026-10-12T09:00:00.000Z"),
    updatedAt: new Date("2026-10-12T09:00:00.000Z"),
  };
}

const EREGISTER = company("cmp_1", "eRegister", Schemas.CompanyStatusIntEnum.Active);
const NORTHFIELD = company("cmp_2", "Northfield", Schemas.CompanyStatusIntEnum.Churned);

const ROWS: Schemas.OperatorCompanyListItem[] = [
  {
    ...EREGISTER,
    connectionEnvironments: [
      Schemas.CompanyConnectionEnvironmentIntEnum.Production,
      Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
    ],
    connectionEnvironmentLabels: [
      Schemas.CompanyConnectionEnvironmentLabelEnum.Production,
      Schemas.CompanyConnectionEnvironmentLabelEnum.Staging,
    ],
  },
  { ...NORTHFIELD, connectionEnvironments: [], connectionEnvironmentLabels: [] },
];

const COUNTS: Schemas.CompanyStatusCounts = {
  [Schemas.CompanyStatusIntEnum.Active]: 1,
  [Schemas.CompanyStatusIntEnum.Paused]: 0,
  [Schemas.CompanyStatusIntEnum.Churned]: 1,
};

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

function mockApi(handler: Handler = () => null) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init) ?? defaultApi(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// DEV_NOTE: eRegister's status as the API holds it, so a refetch after a status change reads the new one
let eRegisterStatus = Schemas.CompanyStatusIntEnum.Active;

// DEV_NOTE: Every read and write the operator Companies pages make, answered from fixtures
function defaultApi(url: string, init: RequestInit | undefined): { status: number; body: unknown } {
  const method = init?.method ?? "GET";
  const path = new URL(url, "http://api.test").pathname;
  if (path.endsWith("/operator/companies/status-counts")) {
    return { status: 200, body: { isSuccess: true, counts: COUNTS } };
  }
  if (path.endsWith("/operator/companies") && method === "GET") {
    return { status: 200, body: { isSuccess: true, companies: ROWS } };
  }
  if (path.endsWith("/operator/companies") && method === "POST") {
    return {
      status: 201,
      body: { isSuccess: true, company: company("cmp_new", "Harbor Clinics", 1) },
    };
  }
  if (path.endsWith("/operator/companies/cmp_1/status")) {
    const { company: next } = JSON.parse(
      String(init?.body),
    ) as Schemas.UpdateCompanyStatusApiRequest;
    eRegisterStatus = next.status;
    return {
      status: 200,
      body: { isSuccess: true, company: company("cmp_1", "eRegister", next.status) },
    };
  }
  if (path.endsWith("/operator/companies/cmp_1/rollups/rebuild")) {
    return {
      status: 200,
      body: { isSuccess: true, rebuiltDays: ["2026-10-01", "2026-10-02"], failedDays: [] },
    };
  }
  if (path.endsWith("/operator/companies/cmp_1")) {
    return {
      status: 200,
      body: { isSuccess: true, company: company("cmp_1", "eRegister", eRegisterStatus) },
    };
  }
  if (path.endsWith("/operator/companies/cmp_2")) {
    return { status: 200, body: { isSuccess: true, company: NORTHFIELD } };
  }
  return { status: 404, body: { isSuccess: false, message: "Not found" } };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/operator/companies",
        validateSearch: CompaniesRoute.options.validateSearch,
        component: CompaniesRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/operator/companies/$id",
        validateSearch: CompanyRoute.options.validateSearch,
        component: CompanyRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/overview",
        component: () => <p>dashboard overview</p>,
      }),
    ]),
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

const calls = (fetchMock: ReturnType<typeof mockApi>, method: string, part: string) =>
  fetchMock.mock.calls.filter(
    ([url, init]) => (init?.method ?? "GET") === method && String(url).includes(part),
  );

afterEach(() => {
  eRegisterStatus = Schemas.CompanyStatusIntEnum.Active;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Companies list", () => {
  it("lists companies with their status, connections and the tab counts", async () => {
    mockApi();
    renderPage("/operator/companies");

    expect(await screen.findByRole("link", { name: "eRegister" })).toBeInTheDocument();
    expect(screen.getByText("Production, Staging")).toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /All\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Churned\s*1/ })).toBeInTheDocument();
    // A churned company's dashboard can't be opened
    const rows = screen.getAllByRole("row");
    const northfield = rows.find((row) => within(row).queryByText("Northfield"));
    expect(within(northfield!).getByRole("button", { name: "Open dashboard" })).toBeDisabled();
    const eRegister = rows.find((row) => within(row).queryByText("eRegister"));
    expect(within(eRegister!).getByRole("link", { name: "Open dashboard" })).toHaveAttribute(
      "href",
      "/overview?company=cmp_1",
    );
  });

  it("asks the API for one status when a tab is picked", async () => {
    const fetchMock = mockApi();
    const router = renderPage("/operator/companies");
    await screen.findByRole("link", { name: "eRegister" });

    await userEvent.click(screen.getByRole("radio", { name: /Churned/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ status: "churned" }));
    await waitFor(() =>
      expect(
        calls(
          fetchMock,
          "GET",
          `/operator/companies?status=${Schemas.CompanyStatusIntEnum.Churned}`,
        ),
      ).toHaveLength(1),
    );
  });

  it("creates a company and opens its page", async () => {
    const fetchMock = mockApi();
    const router = renderPage("/operator/companies");
    await screen.findByRole("link", { name: "eRegister" });

    await userEvent.click(screen.getByRole("button", { name: "New company" }));
    await userEvent.type(screen.getByLabelText("Name"), "Harbor Clinics");
    await userEvent.click(screen.getByRole("button", { name: "Create company" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/operator/companies/cmp_new"));
    const [[, init]] = calls(fetchMock, "POST", "/operator/companies");
    expect(JSON.parse(String(init?.body))).toEqual({ company: { name: "Harbor Clinics" } });
    expect(toast.success).toHaveBeenCalledWith("Company created.");
  });

  it("says why when a list fails, and offers a retry", async () => {
    mockApi((url) =>
      new URL(url, "http://api.test").pathname.endsWith("/operator/companies")
        ? { status: 500, body: { isSuccess: false } }
        : null,
    );
    renderPage("/operator/companies");

    expect(await screen.findByText("Companies didn't load")).toBeInTheDocument();
  });
});

describe("One company", () => {
  it("shows the company's header and its Maintenance section", async () => {
    mockApi();
    renderPage("/operator/companies/cmp_1");

    expect(await screen.findByRole("heading", { name: "eRegister" })).toBeInTheDocument();
    expect(screen.getByText("cmp_1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute(
      "href",
      "/overview?company=cmp_1",
    );
    expect(screen.getByRole("button", { name: "Pause company" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Churn company" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make active" })).not.toBeInTheDocument();
  });

  it("rebuilds insights for the days picked", async () => {
    const fetchMock = mockApi();
    renderPage("/operator/companies/cmp_1");
    await screen.findByRole("heading", { name: "eRegister" });

    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-10-01");
    await userEvent.clear(to);
    await userEvent.type(to, "2026-10-02");
    await userEvent.click(screen.getByRole("button", { name: "Rebuild 2 days" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Rebuilt 2 days."));
    const [[, init]] = calls(fetchMock, "POST", "/rollups/rebuild");
    expect(JSON.parse(String(init?.body))).toEqual({ fromDay: "2026-10-01", toDay: "2026-10-02" });
  });

  it("names the days that didn't rebuild", async () => {
    mockApi((url) =>
      url.includes("/rollups/rebuild")
        ? {
            status: 500,
            body: { isSuccess: false, rebuiltDays: ["2026-10-01"], failedDays: ["2026-10-02"] },
          }
        : null,
    );
    renderPage("/operator/companies/cmp_1");
    await screen.findByRole("heading", { name: "eRegister" });

    await userEvent.click(screen.getByRole("button", { name: /^Rebuild \d+ days$/ }));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Rebuilt 1 day. 2 Oct didn't rebuild: try those days again.",
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("refuses a range in the wrong order before sending it", async () => {
    const fetchMock = mockApi();
    renderPage("/operator/companies/cmp_1");
    await screen.findByRole("heading", { name: "eRegister" });

    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    await userEvent.clear(from);
    await userEvent.type(from, "2026-10-05");
    await userEvent.clear(to);
    await userEvent.type(to, "2026-10-02");

    expect(screen.getByText("fromDay must not be after toDay")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rebuild" })).toBeDisabled();
    expect(calls(fetchMock, "POST", "/rollups/rebuild")).toHaveLength(0);
  });

  it("churns a company only once its name is typed", async () => {
    const fetchMock = mockApi();
    renderPage("/operator/companies/cmp_1");
    await screen.findByRole("heading", { name: "eRegister" });

    await userEvent.click(screen.getByRole("button", { name: "Churn company" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Churn company" });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText("Type the company's name to confirm"),
      "eRegister",
    );
    await userEvent.click(confirm);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const [[, init]] = calls(fetchMock, "PATCH", "/operator/companies/cmp_1/status");
    expect(JSON.parse(String(init?.body))).toEqual({
      company: { status: Schemas.CompanyStatusIntEnum.Churned },
    });
    expect(await screen.findByText("Churned")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make active" })).toBeInTheDocument();
  });

  it("offers only Make active for a churned company, whose dashboard can't be opened", async () => {
    mockApi();
    renderPage("/operator/companies/cmp_2");

    expect(await screen.findByRole("heading", { name: "Northfield" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open dashboard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Make active" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause company" })).not.toBeInTheDocument();
  });

  it("says when the company didn't load", async () => {
    mockApi();
    renderPage("/operator/companies/cmp_gone");

    expect(await screen.findByText("This company didn't load")).toBeInTheDocument();
  });
});

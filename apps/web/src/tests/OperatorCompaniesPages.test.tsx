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
import { Route as CompaniesRoute } from "@/routes/_authenticated/operator/companies/index";
import { Route as CompanyRoute } from "@/routes/_authenticated/operator/companies/$id/index";
import { Route as NewConnectionRoute } from "@/routes/_authenticated/operator/companies/$id/connections/new/index";
import { Route as ConnectionRoute } from "@/routes/_authenticated/operator/companies/$id/connections/$connectionId/index";
import { Route as NewToolRoute } from "@/routes/_authenticated/operator/companies/$id/tools/new/index";
import { Route as ToolRoute } from "@/routes/_authenticated/operator/companies/$id/tools/$toolId/index";

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

function connection(
  publicId: string,
  environment: Schemas.CompanyConnectionEnvironmentIntEnum,
  resetOp: Schemas.ConnectionResetOp | null,
): Schemas.CompanyConnectionWithStatus {
  const host =
    environment === Schemas.CompanyConnectionEnvironmentIntEnum.Staging ? "staging-api" : "api";
  return {
    publicId,
    environment,
    adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
    baseUrl: `https://${host}.eregister.example/v1`,
    authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
    authConfig: {},
    credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
    jwtIssuer: `https://${host}.eregister.example`,
    allowedOrigins: ["https://app.eregister.example"],
    resetOp,
    status: Schemas.CompanyConnectionStatusIntEnum.Active,
    createdAt: new Date("2026-10-12T09:00:00.000Z"),
    updatedAt: new Date("2026-10-12T09:00:00.000Z"),
    companyConnectionStatus: Schemas.CompanyConnectionStatusIntEnum.Active,
    companyConnectionStatusLabel: Schemas.CompanyConnectionStatusLabelEnum.Active,
    companyConnectionEnvironment: environment,
    companyConnectionEnvironmentLabel:
      Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[environment],
    companyConnectionAdapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
    companyConnectionAdapterTypeLabel: Schemas.CompanyConnectionAdapterTypeLabelEnum.Rest,
    companyConnectionCredentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
    companyConnectionCredentialScopeLabel: Schemas.CompanyConnectionCredentialScopeLabelEnum.None,
  };
}

const STAGING = connection("con_stg", Schemas.CompanyConnectionEnvironmentIntEnum.Staging, {
  method: Schemas.ToolOpMethodEnum.Post,
  path: "/test-data/reset",
});
const PRODUCTION = connection(
  "con_prd",
  Schemas.CompanyConnectionEnvironmentIntEnum.Production,
  null,
);

const READ_OPS: Schemas.ToolOps = {
  inputSchema: {
    type: "object",
    properties: { registerId: { type: "string" } },
    required: ["registerId"],
  },
  callOp: { method: Schemas.ToolOpMethodEnum.Get, path: "/registers/{args.registerId}" },
  readbackOp: null,
  inverseOp: null,
};

function tool(
  publicId: string,
  version: number,
  status: Schemas.ToolDefinitionStatusIntEnum,
  risk: Schemas.ToolDefinitionRiskIntEnum = Schemas.ToolDefinitionRiskIntEnum.Read,
): Schemas.ToolDefinitionWithStatus {
  return {
    publicId,
    name: "eregister_get_register",
    version,
    description: "Read one register",
    risk,
    schemaVersion: 1,
    idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.None,
    approval: Schemas.ToolDefinitionApprovalIntEnum.Never,
    source: Schemas.ToolDefinitionSourceIntEnum.Manual,
    status,
    connectionPublicId: "con_stg",
    createdAt: new Date("2026-10-28T09:00:00.000Z"),
    updatedAt: new Date("2026-10-28T09:00:00.000Z"),
    ops: READ_OPS,
    toolDefinitionStatus: status,
    toolDefinitionStatusLabel: Schemas.TOOL_DEFINITION_STATUS_LABEL_MAP[status],
    riskLabel: Schemas.TOOL_DEFINITION_RISK_LABEL_MAP[risk],
    idempotencyModeLabel: Schemas.ToolDefinitionIdempotencyModeLabelEnum.None,
    approvalLabel: Schemas.ToolDefinitionApprovalLabelEnum.Never,
    sourceLabel: Schemas.ToolDefinitionSourceLabelEnum.Manual,
  };
}

const TOOL_V1 = tool("tool_1", 1, Schemas.ToolDefinitionStatusIntEnum.Active);
const TOOL_V2 = tool("tool_2", 2, Schemas.ToolDefinitionStatusIntEnum.Draft);
// A write draft with no readback: the API would refuse it
const TOOL_BAD = tool(
  "tool_bad",
  3,
  Schemas.ToolDefinitionStatusIntEnum.Draft,
  Schemas.ToolDefinitionRiskIntEnum.Write,
);

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
  if (path.endsWith("/tool-definitions/count")) {
    return { status: 200, body: { isSuccess: true, totalRecords: 1 } };
  }
  if (path.endsWith("/operator/companies/cmp_1/tool-definitions") && method === "GET") {
    return { status: 200, body: { isSuccess: true, toolDefinitions: [TOOL_V2, TOOL_V1] } };
  }
  if (path.endsWith("/operator/companies/cmp_1/tool-definitions") && method === "POST") {
    return { status: 201, body: { isSuccess: true, toolDefinition: TOOL_V2 } };
  }
  if (path.endsWith("/tool-definitions/tool_1/versions")) {
    return { status: 201, body: { isSuccess: true, toolDefinition: TOOL_V2 } };
  }
  if (path.endsWith("/tool-definitions/tool_2/status")) {
    return {
      status: 200,
      body: {
        isSuccess: true,
        toolDefinition: tool("tool_2", 2, Schemas.ToolDefinitionStatusIntEnum.Active),
      },
    };
  }
  for (const found of [TOOL_V1, TOOL_V2, TOOL_BAD]) {
    if (path.endsWith(`/tool-definitions/${found.publicId}`)) {
      return { status: 200, body: { isSuccess: true, toolDefinition: found } };
    }
  }
  if (path.endsWith("/operator/companies/cmp_1/connections") && method === "GET") {
    return { status: 200, body: { isSuccess: true, companyConnections: [STAGING, PRODUCTION] } };
  }
  if (path.endsWith("/operator/companies/cmp_1/connections") && method === "POST") {
    return { status: 201, body: { isSuccess: true, companyConnection: PRODUCTION } };
  }
  if (path.endsWith("/operator/companies/cmp_1/connections/con_stg")) {
    return { status: 200, body: { isSuccess: true, companyConnection: STAGING } };
  }
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
        path: "/operator/companies/$id/connections/new",
        component: NewConnectionRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/operator/companies/$id/connections/$connectionId",
        component: ConnectionRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/operator/companies/$id/tools/new",
        component: NewToolRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/operator/companies/$id/tools/$toolId",
        component: ToolRoute.options.component,
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
    renderPage("/operator/companies/cmp_1?tab=maintenance");

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
    renderPage("/operator/companies/cmp_1?tab=maintenance");
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
    renderPage("/operator/companies/cmp_1?tab=maintenance");
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
    renderPage("/operator/companies/cmp_1?tab=maintenance");
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
    renderPage("/operator/companies/cmp_1?tab=maintenance");
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
    renderPage("/operator/companies/cmp_2?tab=maintenance");

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

describe("Connections", () => {
  it("shows the company's connections by default, staging first", async () => {
    mockApi();
    renderPage("/operator/companies/cmp_1");

    const staging = await screen.findByRole("group", { name: "Staging connection" });
    expect(
      within(staging).getByText("https://staging-api.eregister.example/v1"),
    ).toBeInTheDocument();
    expect(within(staging).getByText("Forward the user's token")).toBeInTheDocument();
    expect(within(staging).getByText("POST /test-data/reset")).toBeInTheDocument();
    const production = screen.getByRole("group", { name: "Production connection" });
    expect(within(production).queryByText("Clean-up after tests")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add connection" })).toHaveAttribute(
      "href",
      "/operator/companies/cmp_1/connections/new",
    );
  });

  it("adds a connection with the fields the API needs, then goes back", async () => {
    const fetchMock = mockApi();
    const router = renderPage("/operator/companies/cmp_1/connections/new");

    await userEvent.type(
      await screen.findByLabelText("API address"),
      "https://staging-api.harbor.example/v1",
    );
    await userEvent.type(screen.getByLabelText("JWT issuer"), "https://staging-api.harbor.example");
    await userEvent.type(screen.getByLabelText("Allowed origins"), "https://app.harbor.example");
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/operator/companies/cmp_1"));
    const [[, init]] = calls(fetchMock, "POST", "/operator/companies/cmp_1/connections");
    expect(JSON.parse(String(init?.body))).toEqual({
      companyConnection: {
        environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
        adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
        baseUrl: "https://staging-api.harbor.example/v1",
        authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
        authConfig: {},
        credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
        jwtIssuer: "https://staging-api.harbor.example",
        allowedOrigins: ["https://app.harbor.example"],
        resetOp: null,
      },
    });
    expect(toast.success).toHaveBeenCalledWith("Connection added.");
  });

  it("shows a taken issuer on its field and stays on the page", async () => {
    mockApi((url, init) =>
      init?.method === "POST" && url.includes("/connections")
        ? {
            status: 409,
            body: { isSuccess: false, failure: Schemas.CompanyConnectionFailureEnum.IssuerTaken },
          }
        : null,
    );
    const router = renderPage("/operator/companies/cmp_1/connections/new");

    await userEvent.type(
      await screen.findByLabelText("API address"),
      "https://staging-api.harbor.example/v1",
    );
    await userEvent.type(
      screen.getByLabelText("JWT issuer"),
      "https://staging-api.eregister.example",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add connection" }));

    expect(
      await screen.findByText("Another connection already uses this issuer"),
    ).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(
      "Another connection already uses this JWT issuer. Nothing was saved.",
    );
    expect(router.state.location.pathname).toBe("/operator/companies/cmp_1/connections/new");
  });

  it("refuses an issuer that isn't https before sending it", async () => {
    const fetchMock = mockApi();
    renderPage("/operator/companies/cmp_1/connections/new");

    await userEvent.type(await screen.findByLabelText("JWT issuer"), "http://issuer.example");
    expect(screen.getByLabelText("JWT issuer")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Add connection" })).toBeDisabled();
    expect(calls(fetchMock, "POST", "/connections")).toHaveLength(0);
  });

  it("edits a connection: fixed settings read-only, the rest sent with its status", async () => {
    const fetchMock = mockApi((url, init) =>
      init?.method === "PATCH"
        ? { status: 200, body: { isSuccess: true, companyConnection: STAGING } }
        : null,
    );
    const router = renderPage("/operator/companies/cmp_1/connections/con_stg");

    expect(await screen.findByRole("heading", { name: "Staging connection" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Environment")).not.toBeInTheDocument();
    const origins = screen.getByLabelText("Allowed origins");
    await userEvent.type(origins, "{enter}http://localhost:5173");
    await userEvent.click(screen.getByRole("switch", { name: "Active" }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/operator/companies/cmp_1"));
    const [[, init]] = calls(fetchMock, "PATCH", "/connections/con_stg");
    expect(JSON.parse(String(init?.body))).toEqual({
      companyConnection: {
        baseUrl: "https://staging-api.eregister.example/v1",
        jwtIssuer: "https://staging-api.eregister.example",
        authConfig: {},
        allowedOrigins: ["https://app.eregister.example", "http://localhost:5173"],
        status: Schemas.CompanyConnectionStatusIntEnum.Disabled,
        resetOp: { method: "POST", path: "/test-data/reset" },
      },
    });
  });
});

describe("Tools", () => {
  it("lists the company's tool versions with their status, risk and connection", async () => {
    const fetchMock = mockApi();
    renderPage("/operator/companies/cmp_1?tab=tools");

    const links = await screen.findAllByRole("link", { name: "eregister_get_register" });
    expect(links[0]).toHaveAttribute("href", "/operator/companies/cmp_1/tools/tool_2");
    expect(screen.getAllByText("Staging").length).toBeGreaterThan(0);
    expect(screen.getByText("v1")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls(
          fetchMock,
          "GET",
          `/tool-definitions?status=${Schemas.ToolDefinitionStatusIntEnum.Active}&pageNo=1`,
        ),
      ).toHaveLength(1),
    );
  });

  it("creates a read tool as a draft with the checked ops, then opens it", async () => {
    const fetchMock = mockApi();
    const router = renderPage("/operator/companies/cmp_1/tools/new");

    await userEvent.type(await screen.findByLabelText("Name"), "eregister_get_register");
    await userEvent.type(screen.getByLabelText("Description"), "Read one register");
    await userEvent.click(screen.getByRole("button", { name: "Create draft" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/operator/companies/cmp_1/tools/tool_2"),
    );
    const [[, init]] = calls(fetchMock, "POST", "/tool-definitions");
    expect(JSON.parse(String(init?.body))).toEqual({
      toolDefinition: {
        connectionPublicId: "con_stg",
        name: "eregister_get_register",
        description: "Read one register",
        risk: Schemas.ToolDefinitionRiskIntEnum.Read,
        idempotencyMode: Schemas.ToolDefinitionIdempotencyModeIntEnum.None,
        approval: Schemas.ToolDefinitionApprovalIntEnum.Always,
        source: Schemas.ToolDefinitionSourceIntEnum.Manual,
        ops: {
          inputSchema: { type: "object", properties: {} },
          callOp: { method: "GET", path: "/" },
          readbackOp: null,
          inverseOp: null,
        },
      },
    });
  });

  it("says why a draft can't be saved, before sending it", async () => {
    const fetchMock = mockApi();
    renderPage("/operator/companies/cmp_1/tools/tool_bad");

    expect(await screen.findByText("A write tool needs a readback op")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Make active" })).toBeDisabled();
    expect(calls(fetchMock, "PATCH", "/tool-definitions")).toHaveLength(0);
  });

  it("makes a saved draft active", async () => {
    const fetchMock = mockApi();
    renderPage("/operator/companies/cmp_1/tools/tool_2");

    await userEvent.click(await screen.findByRole("button", { name: "Make active" }));

    await waitFor(() => expect(calls(fetchMock, "PUT", "/tool_2/status")).toHaveLength(1));
    const [[, init]] = calls(fetchMock, "PUT", "/tool_2/status");
    expect(JSON.parse(String(init?.body))).toEqual({
      status: Schemas.ToolDefinitionStatusIntEnum.Active,
    });
  });

  it("shows an active version read-only and starts a new version from it", async () => {
    mockApi();
    const router = renderPage("/operator/companies/cmp_1/tools/tool_1");

    expect(await screen.findByLabelText("Call")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New version" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/operator/companies/cmp_1/tools/tool_2"),
    );
  });

  it("loads a tool set onto the chosen connection and shows what changed and the pins", async () => {
    const tools: Schemas.ToolSetTool[] = [
      { name: "eregister_list_companies", version: 1, change: Schemas.ToolSetChangeEnum.Created },
      { name: "eregister_get_register", version: 2, change: Schemas.ToolSetChangeEnum.Unchanged },
    ];
    const fetchMock = mockApi((url, init) =>
      init?.method === "POST" && url.endsWith("/tool-definitions/tool-sets")
        ? { status: 200, body: { isSuccess: true, tools } }
        : null,
    );
    renderPage("/operator/companies/cmp_1?tab=tools");

    await userEvent.click(await screen.findByRole("button", { name: "Load tool set" }));
    expect(screen.getByRole("button", { name: "Load tools" })).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: "Connection" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "Production · https://api.eregister.example/v1" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Load tools" }));

    expect(await screen.findByText("Tools loaded")).toBeInTheDocument();
    const [[, init]] = calls(fetchMock, "POST", "/tool-definitions/tool-sets");
    expect(JSON.parse(String(init?.body))).toEqual({
      toolSet: Schemas.ToolSetEnum.Eregister,
      connectionPublicId: "con_prd",
    });
    expect(screen.getByText(/2 tools: 1 new, 1 unchanged/)).toBeInTheDocument();
    expect(JSON.parse((screen.getByLabelText("Pins") as HTMLTextAreaElement).value)).toEqual([
      { name: "eregister_list_companies", version: 1 },
      { name: "eregister_get_register", version: 2 },
    ]);
  });

  it("names the tools whose drafts refuse a tool set load", async () => {
    const message =
      "These tools have a draft version; make it active or delete it first: eregister_get_register";
    mockApi((url, init) =>
      init?.method === "POST" && url.endsWith("/tool-definitions/tool-sets")
        ? {
            status: 409,
            body: {
              isSuccess: false,
              message,
              failure: Schemas.ToolDefinitionFailureEnum.DraftExists,
            },
          }
        : null,
    );
    renderPage("/operator/companies/cmp_1?tab=tools");

    await userEvent.click(await screen.findByRole("button", { name: "Load tool set" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Connection" }));
    await userEvent.click(await screen.findByRole("option", { name: /^Staging/ }));
    await userEvent.click(screen.getByRole("button", { name: "Load tools" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(screen.queryByText("Tools loaded")).not.toBeInTheDocument();
  });

  it("says why a version can't be disabled", async () => {
    mockApi((url, init) =>
      init?.method === "PUT"
        ? {
            status: 409,
            body: {
              isSuccess: false,
              failure: Schemas.ToolDefinitionFailureEnum.PinnedByPublishedConfig,
            },
          }
        : null,
    );
    renderPage("/operator/companies/cmp_1/tools/tool_1");

    await userEvent.click(await screen.findByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "A published bot version uses this tool version. Publish one without it first.",
      ),
    );
  });
});

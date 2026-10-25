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
import { Route as SecurityRoute } from "@/routes/_authenticated/security/index";

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

const PRODUCTION: Schemas.SecurityConnection = {
  publicId: "conn_prod",
  environment: Schemas.CompanyConnectionEnvironmentIntEnum.Production,
  environmentLabel: Schemas.CompanyConnectionEnvironmentLabelEnum.Production,
  status: Schemas.CompanyConnectionStatusIntEnum.Active,
  statusLabel: Schemas.CompanyConnectionStatusLabelEnum.Active,
  jwtIssuer: "https://api.eregister.com",
  allowedOrigins: ["https://app.eregister.com", "https://help.eregister.com"],
  signingKeysFetchedAt: new Date().toISOString(),
};

const STAGING: Schemas.SecurityConnection = {
  ...PRODUCTION,
  publicId: "conn_staging",
  environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
  environmentLabel: Schemas.CompanyConnectionEnvironmentLabelEnum.Staging,
  jwtIssuer: "https://staging.eregister.com",
  allowedOrigins: ["https://staging.eregister.com"],
  signingKeysFetchedAt: null,
};

const ACTIVE_KEY: Schemas.SecurityEncryptionKey = {
  version: 1,
  status: Schemas.CompanyEncryptionKeyStatusIntEnum.Active,
  statusLabel: Schemas.CompanyEncryptionKeyStatusLabelEnum.Active,
  createdAt: "2026-02-02T09:00:00.000Z",
  rotatedAt: null,
};

const INJECTION: Schemas.InjectionEvent = {
  publicId: "qi_1",
  conversationPublicId: "conv_1",
  conversationTitle: "Bulk import help",
  detectedIn: "Record note on EXT-T-901",
  status: Schemas.QualityIssueStatusIntEnum.Open,
  statusLabel: Schemas.QualityIssueStatusLabelEnum.Open,
  actionLabel: "Waiting for review",
  createdAt: "2026-09-28T12:04:00.000Z",
};

const AUDIT: Schemas.AuditLogEntry[] = [
  {
    actorType: Schemas.ActivityLogActorTypeIntEnum.Admin,
    actorTypeLabel: Schemas.ActivityLogActorTypeLabelEnum.Admin,
    actorName: "Ana Ruiz",
    action: "Rotated encryption key",
    on: "v3",
    createdAt: "2026-09-28T10:20:00.000Z",
  },
  {
    actorType: Schemas.ActivityLogActorTypeIntEnum.Operator,
    actorTypeLabel: Schemas.ActivityLogActorTypeLabelEnum.Operator,
    actorName: null,
    action: "Activated tool",
    on: "update_record v2",
    createdAt: "2026-09-21T16:02:00.000Z",
  },
];

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

function mockApi(handler: Handler = () => null) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init) ?? defaultApi(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// DEV_NOTE: Every read and write the Security page makes, answered from fixtures
function defaultApi(url: string, init?: RequestInit): { status: number; body: unknown } {
  const method = init?.method ?? "GET";
  if (url.includes("/origins")) {
    const body = JSON.parse(String(init?.body)) as Schemas.UpdateAllowedOriginsApiRequest;
    return {
      status: 200,
      body: { isSuccess: true, connection: { ...PRODUCTION, allowedOrigins: body.allowedOrigins } },
    };
  }
  if (url.endsWith("/security/connections")) {
    return { status: 200, body: { isSuccess: true, connections: [PRODUCTION, STAGING] } };
  }
  if (url.endsWith("/encryption-keys/rotate")) {
    return {
      status: 200,
      body: {
        isSuccess: true,
        isRotationInProgress: true,
        encryptionKeys: [
          { ...ACTIVE_KEY, version: 2, createdAt: "2026-10-25T09:00:00.000Z" },
          {
            ...ACTIVE_KEY,
            status: Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring,
            statusLabel: Schemas.CompanyEncryptionKeyStatusLabelEnum.Retiring,
            rotatedAt: "2026-10-25T09:00:00.000Z",
          },
        ],
      },
    };
  }
  if (url.endsWith("/encryption-keys")) {
    return {
      status: 200,
      body: { isSuccess: true, isRotationInProgress: false, encryptionKeys: [ACTIVE_KEY] },
    };
  }
  if (url.endsWith("/security/retention")) {
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Schemas.UpdateContentRetentionApiRequest;
      return {
        status: 200,
        body: {
          isSuccess: true,
          retention: { contentRetentionDays: body.contentRetentionDays, isDefault: false },
        },
      };
    }
    return {
      status: 200,
      body: { isSuccess: true, retention: { contentRetentionDays: 30, isDefault: true } },
    };
  }
  if (url.includes("/injection-events/count")) {
    return { status: 200, body: { isSuccess: true, totalRecords: 1 } };
  }
  if (url.includes("/injection-events")) {
    return { status: 200, body: { isSuccess: true, injectionEvents: [INJECTION] } };
  }
  if (url.includes("/audit-log/count")) {
    return { status: 200, body: { isSuccess: true, totalRecords: 2 } };
  }
  if (url.includes("/audit-log/export")) {
    return { status: 200, body: { isSuccess: true, auditLog: AUDIT, isTruncated: false } };
  }
  return { status: 200, body: { isSuccess: true, auditLog: AUDIT } };
}

function renderPage(path = "/security") {
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/security",
    validateSearch: SecurityRoute.options.validateSearch,
    component: SecurityRoute.options.component,
  });
  const stub = (to: string) =>
    createRoute({ getParentRoute: () => rootRoute, path: to, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route, stub("/quality/$id"), stub("/conversations/$id")]),
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
  vi.unstubAllGlobals();
  toast.error.mockReset();
  toast.success.mockReset();
});

describe("Security page", () => {
  it("shows each connection's issuer, signing keys and allowed origins", async () => {
    mockApi();
    renderPage();

    const section = await screen.findByRole("region", { name: "Identity and origins" });
    expect(await within(section).findByText("https://api.eregister.com")).toBeInTheDocument();
    expect(
      within(section).getByText(/^Fetched from the issuer, cached\. Last refreshed today/),
    ).toBeInTheDocument();
    const origins = within(section).getAllByRole("list", { name: "Allowed origins" })[0]!;
    expect(within(origins).getByText("app.eregister.com")).toBeInTheDocument();
    expect(within(origins).getByText("help.eregister.com")).toBeInTheDocument();
    expect(
      within(section).getByText("Fetched from the issuer when a user next signs in."),
    ).toBeInTheDocument();
    expect(within(section).getByText("Test runs only, never your live users.")).toBeInTheDocument();
  });

  it("edits a connection's allowed origins, refusing one with a path", async () => {
    const fetchMock = mockApi();
    renderPage();

    const section = await screen.findByRole("region", { name: "Identity and origins" });
    await within(section).findByText("https://api.eregister.com");
    await userEvent.click(within(section).getAllByRole("button", { name: "Edit" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Allowed origins · Production" });
    const field = within(dialog).getByLabelText("Origins");

    await userEvent.clear(field);
    await userEvent.type(field, "https://app.eregister.com/widget");
    expect(await within(dialog).findByText(/no path/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, "https://app.eregister.com{enter}https://portal.eregister.com");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls(fetchMock, "PUT", "/conn_prod/origins")).toHaveLength(1));
    const [, init] = calls(fetchMock, "PUT", "/conn_prod/origins")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      allowedOrigins: ["https://app.eregister.com", "https://portal.eregister.com"],
    });
    expect(toast.success).toHaveBeenCalledWith("Allowed origins saved.");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(section).findByText("portal.eregister.com")).toBeInTheDocument();
  });

  it("rotates the key after a confirm, then waits for the rotation to finish", async () => {
    const fetchMock = mockApi();
    renderPage();

    const section = await screen.findByRole("region", { name: "Encryption keys" });
    const row = (await within(section).findByText("v1")).closest("tr")!;
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("2 Feb")).toBeInTheDocument();

    await userEvent.click(within(section).getByRole("button", { name: "Rotate key" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Rotate the encryption key?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Rotate key" }));

    await waitFor(() =>
      expect(calls(fetchMock, "POST", "/encryption-keys/rotate")).toHaveLength(1),
    );
    expect(await within(section).findByText("v2")).toBeInTheDocument();
    expect(within(section).getByText("Retiring")).toBeInTheDocument();
    expect(within(section).getByText(/A rotation is in progress/)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Rotate key" })).toBeDisabled();
  });

  it("says a rotation already in progress changed nothing", async () => {
    mockApi((url) =>
      url.endsWith("/encryption-keys/rotate")
        ? {
            status: 409,
            body: {
              isSuccess: false,
              failure: Schemas.EncryptionKeyRotateFailureEnum.RotationInProgress,
            },
          }
        : null,
    );
    renderPage();

    const section = await screen.findByRole("region", { name: "Encryption keys" });
    await within(section).findByText("v1");
    await userEvent.click(within(section).getByRole("button", { name: "Rotate key" }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Rotate key" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "A rotation is still in progress. Try again once the old key is retired.",
      ),
    );
  });

  it("saves how long chat content is kept", async () => {
    const fetchMock = mockApi();
    renderPage();

    const section = await screen.findByRole("region", { name: "Retention" });
    const select = await within(section).findByRole("combobox", { name: "Keep chat content for" });
    expect(select).toHaveTextContent("30 days");
    expect(within(section).getByText(/This is the default until you choose\./)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Save retention" })).toBeDisabled();
    expect(within(section).queryByText(/Erase/)).toBeNull();

    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "90 days" }));
    await userEvent.click(within(section).getByRole("button", { name: "Save retention" }));

    await waitFor(() => expect(calls(fetchMock, "PUT", "/security/retention")).toHaveLength(1));
    const [, init] = calls(fetchMock, "PUT", "/security/retention")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ contentRetentionDays: 90 });
    expect(toast.success).toHaveBeenCalledWith("Retention saved.");
  });

  it("lists prompt-injection events linked to their issue and conversation", async () => {
    mockApi();
    renderPage();

    const section = await screen.findByRole("region", { name: "Prompt-injection events" });
    const issue = await within(section).findByRole("link", { name: "Record note on EXT-T-901" });
    expect(issue).toHaveAttribute("href", "/quality/qi_1");
    expect(within(section).getByRole("link", { name: "Bulk import help" })).toHaveAttribute(
      "href",
      "/conversations/conv_1",
    );
    expect(within(section).getByText("Waiting for review")).toBeInTheDocument();
  });

  it("shows an empty state when there are no prompt-injection events", async () => {
    mockApi((url) =>
      url.includes("/injection-events") && !url.includes("/count")
        ? { status: 200, body: { isSuccess: true, injectionEvents: [] } }
        : null,
    );
    renderPage();

    const section = await screen.findByRole("region", { name: "Prompt-injection events" });
    expect(await within(section).findByText(/No prompt-injection events\./)).toBeInTheDocument();
  });

  it("lists the audit log in words, an operator without a name, and exports it", async () => {
    const fetchMock = mockApi();
    const createObjectURL = vi.fn(() => "blob:audit");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    renderPage();

    const section = await screen.findByRole("region", { name: "Audit log" });
    const row = (await within(section).findByText("Rotated encryption key")).closest("tr")!;
    expect(within(row).getByText("Ana Ruiz")).toBeInTheDocument();
    expect(within(row).getByText("v3")).toBeInTheDocument();
    const operatorRow = within(section).getByText("Activated tool").closest("tr")!;
    expect(within(operatorRow).getByText("Operator")).toBeInTheDocument();

    await userEvent.click(within(section).getByRole("button", { name: "Export" }));
    await waitFor(() => expect(calls(fetchMock, "GET", "/audit-log/export")).toHaveLength(1));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Exported 2 rows."));
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("shows what didn't load, with a retry", async () => {
    mockApi((url) =>
      url.includes("/audit-log") && !url.includes("/count")
        ? { status: 500, body: { isSuccess: false } }
        : null,
    );
    renderPage();

    const section = await screen.findByRole("region", { name: "Audit log" });
    expect(await within(section).findByText("The audit log didn't load")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
  it("offers a way back from an audit page past the end", async () => {
    mockApi((url) => {
      if (url.includes("/audit-log/count")) {
        return { status: 200, body: { isSuccess: true, totalRecords: 30 } };
      }
      if (url.includes("/audit-log") && url.includes("pageNo=9")) {
        return { status: 200, body: { isSuccess: true, auditLog: [] } };
      }
      return null;
    });
    const router = renderPage("/security?auditPage=9");

    const section = await screen.findByRole("region", { name: "Audit log" });
    expect(await within(section).findByText("Nothing on this page.")).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Go to the last page" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ auditPage: 2 }));
  });

  it("keeps paging the audit log when its count didn't load", async () => {
    const fullPage = Array.from({ length: Schemas.AUDIT_LOG_PAGE_SIZE }, (_, index) => ({
      ...AUDIT[0]!,
      on: `v${index + 1}`,
    }));
    mockApi((url) => {
      if (url.includes("/audit-log/count")) return { status: 500, body: { isSuccess: false } };
      if (url.includes("/audit-log")) {
        return { status: 200, body: { isSuccess: true, auditLog: fullPage } };
      }
      return null;
    });
    const router = renderPage();

    const section = await screen.findByRole("region", { name: "Audit log" });
    expect(await within(section).findByText("Page 1")).toBeInTheDocument();
    const next = within(section).getByRole("button", { name: "Next" });
    expect(next).toBeEnabled();
    await userEvent.click(next);
    await waitFor(() => expect(router.state.location.search).toMatchObject({ auditPage: 2 }));
  });
});

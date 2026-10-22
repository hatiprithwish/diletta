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
import { TooltipProvider } from "@app/ui/components/tooltip";
import * as Schemas from "@app/schemas";
import { ThemeProvider } from "@/providers/ThemeProvider";
import { Route as AuthenticatedRoute } from "@/routes/_authenticated/route";
import { NAV_GROUPS, getBreadcrumbs } from "@/routes/_authenticated/-nav";

const auth = vi.hoisted(() => ({ userId: "user_1" }));

vi.mock("@clerk/tanstack-react-start", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    userId: auth.userId,
    getToken: async () => "token",
  }),
  useClerk: () => ({ signOut: vi.fn() }),
}));

const COMPANY_ADMIN: Schemas.AdminProfile = {
  clerkUserId: "user_1",
  email: "ana@northfield.example",
  name: "Ana Ruiz",
  createdAt: new Date(),
  updatedAt: new Date(),
  role: Schemas.AdminRoleEnum.CompanyAdmin,
  company: { publicId: "cmp_1", name: "eRegister" },
};

function mockMe(status: number, body: Schemas.GetMeApiResponse) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

// The real _authenticated layout over a router holding every nav path, each page rendering its own path
function renderShell(
  path: string,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const layoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_authenticated",
    component: AuthenticatedRoute.options.component,
  });
  const paths = NAV_GROUPS.flatMap((group) =>
    group.items.flatMap((item): string[] =>
      "items" in item ? item.items.map((subItem) => subItem.to) : [item.to],
    ),
  );
  const pageRoutes = paths.map((to) =>
    createRoute({
      getParentRoute: () => layoutRoute,
      path: to,
      component: () => <p>page {to}</p>,
    }),
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([layoutRoute.addChildren(pageRoutes)]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light" storageKey="test-theme">
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

// The breadcrumb's current page also has role link, so nav queries look inside the sidebar only
function sidebar() {
  const element = document.querySelector<HTMLElement>('[data-slot="sidebar"]');
  if (!element) throw new Error("sidebar not rendered");
  return within(element);
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  // Node's own localStorage shadows jsdom's; the theme provider only needs get/set
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  auth.userId = "user_1";
  document.cookie = "sidebar_state=; max-age=0; path=/";
  document.documentElement.classList.remove("light", "dark");
});

describe("dashboard shell", () => {
  it("renders the company header, the grouped nav and the page", async () => {
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    renderShell("/overview");

    expect(await screen.findByText("page /overview")).toBeInTheDocument();
    expect(screen.getByText("Companion")).toBeInTheDocument();
    expect(screen.getByText("eRegister")).toBeInTheDocument();
    for (const label of ["Monitor", "Improve", "Insights", "Admin"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(sidebar().getByRole("link", { name: "Overview" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(sidebar().getByRole("link", { name: "Changes" })).toHaveAttribute(
      "data-active",
      "false",
    );
    // Settings stays closed off a settings page
    expect(sidebar().queryByRole("link", { name: "Model keys" })).not.toBeInTheDocument();
    expect(screen.getByText("Ana Ruiz")).toBeInTheDocument();
    expect(screen.getByText("ana@northfield.example")).toBeInTheDocument();
  });

  it("opens Settings and shows Settings › Bots on a settings page", async () => {
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    renderShell("/settings/bots");

    expect(await screen.findByText("page /settings/bots")).toBeInTheDocument();
    expect(sidebar().getByRole("link", { name: "Bots" })).toHaveAttribute("data-active", "true");
    expect(sidebar().getByRole("link", { name: "Model keys" })).toBeInTheDocument();
    const breadcrumb = within(screen.getByRole("navigation", { name: "breadcrumb" }));
    expect(breadcrumb.getByText("Settings")).toBeInTheDocument();
    expect(breadcrumb.getByText("Bots")).toBeInTheDocument();
  });

  it("toggles between light and dark", async () => {
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    renderShell("/overview");

    await userEvent.click(await screen.findByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement).toHaveClass("dark");
    await userEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement).toHaveClass("light");
  });

  it("shows No access when the admin isn't invited (403)", async () => {
    mockMe(403, { isSuccess: true });
    renderShell("/overview");

    expect(await screen.findByText("You don't have access to this dashboard")).toBeInTheDocument();
    expect(screen.queryByText("page /overview")).not.toBeInTheDocument();
  });

  it("shows No access to an operator", async () => {
    mockMe(200, {
      isSuccess: true,
      admin: { ...COMPANY_ADMIN, role: Schemas.AdminRoleEnum.Operator, company: null },
    });
    renderShell("/overview");

    expect(await screen.findByText("You don't have access to this dashboard")).toBeInTheDocument();
  });

  it("offers a retry when /dashboard/me fails", async () => {
    mockMe(500, { isSuccess: false, message: "boom" });
    renderShell("/overview");

    expect(await screen.findByText("The dashboard didn't load")).toBeInTheDocument();
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("page /overview")).toBeInTheDocument();
  });
});

describe("dashboard shell state", () => {
  it("keeps the page mounted when a background refetch of /dashboard/me fails", async () => {
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderShell("/overview", queryClient);
    expect(await screen.findByText("page /overview")).toBeInTheDocument();

    mockMe(500, { isSuccess: false, message: "boom" });
    await queryClient.refetchQueries();

    await waitFor(() =>
      expect(queryClient.getQueryState(["me", "detail", "user_1"])?.status).toBe("error"),
    );
    expect(screen.getByText("page /overview")).toBeInTheDocument();
    expect(screen.queryByText("The dashboard didn't load")).not.toBeInTheDocument();
  });

  it("shows No access when a refetch answers 403 (company churned)", async () => {
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderShell("/overview", queryClient);
    expect(await screen.findByText("page /overview")).toBeInTheDocument();

    mockMe(403, { isSuccess: true });
    await queryClient.refetchQueries();

    expect(await screen.findByText("You don't have access to this dashboard")).toBeInTheDocument();
  });

  it("asks /dashboard/me again for another Clerk user in the same tab", async () => {
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = renderShell("/overview", queryClient);
    expect(await screen.findByText("Ana Ruiz")).toBeInTheDocument();
    first.unmount();

    auth.userId = "user_2";
    mockMe(200, {
      isSuccess: true,
      admin: { ...COMPANY_ADMIN, clerkUserId: "user_2", name: "Ben Ito", email: "ben@example.com" },
    });
    renderShell("/overview", queryClient);

    expect(await screen.findByText("Ben Ito")).toBeInTheDocument();
    expect(screen.queryByText("Ana Ruiz")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("starts as the icon rail when the sidebar was collapsed before", async () => {
    document.cookie = "sidebar_state=false; path=/";
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    renderShell("/overview");

    expect(await screen.findByText("page /overview")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sidebar"]')).toHaveAttribute(
      "data-state",
      "collapsed",
    );
  });

  it("closes the mobile sidebar after navigating", async () => {
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    mockMe(200, { isSuccess: true, admin: COMPANY_ADMIN });
    renderShell("/overview");
    expect(await screen.findByText("page /overview")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
    const sheet = await screen.findByRole("dialog");
    await userEvent.click(within(sheet).getByRole("link", { name: "Changes" }));

    expect(await screen.findByText("page /changes")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("getBreadcrumbs", () => {
  it("maps a path to its crumbs", () => {
    expect(getBreadcrumbs("/overview")).toEqual(["Overview"]);
    expect(getBreadcrumbs("/changes/cr_1")).toEqual(["Changes"]);
    expect(getBreadcrumbs("/settings/model-keys")).toEqual(["Settings", "Model keys"]);
    expect(getBreadcrumbs("/unknown")).toEqual([]);
  });
});

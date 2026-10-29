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
import { Route as ModelKeysRoute } from "@/routes/_authenticated/settings/model-keys/index";
import { Route as BudgetRoute } from "@/routes/_authenticated/settings/budget/index";
import { Route as ConnectionsRoute } from "@/routes/_authenticated/settings/connections/index";
import { Route as TeamRoute } from "@/routes/_authenticated/settings/team/index";

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

// DEV_NOTE: Plainly fake values: a secret scanner must not mistake them for real keys
const NEW_KEY = "test-anthropic-key-9921";
const ROTATED_KEY = "test-google-key-7781";

const GOOGLE_KEY: Schemas.ModelKey = {
  publicId: "key_google",
  provider: Schemas.ModelProviderEnum.Google,
  providerLabel: "Google",
  lastFourChars: "4417",
  status: Schemas.CompanySecretStatusIntEnum.Invalid,
  statusLabel: Schemas.CompanySecretStatusLabelEnum.Invalid,
  lastValidatedAt: "2026-10-01T08:00:00.000Z",
  rotatedAt: null,
  createdAt: "2026-10-01T08:00:00.000Z",
};

const ANTHROPIC_KEY: Schemas.ModelKey = {
  publicId: "key_anthropic",
  provider: Schemas.ModelProviderEnum.Anthropic,
  providerLabel: "Anthropic",
  lastFourChars: NEW_KEY.slice(-4),
  status: Schemas.CompanySecretStatusIntEnum.Active,
  statusLabel: Schemas.CompanySecretStatusLabelEnum.Active,
  lastValidatedAt: "2026-10-28T09:00:00.000Z",
  rotatedAt: null,
  createdAt: "2026-10-28T09:00:00.000Z",
};

const BUDGET: Schemas.SpendingBudget = {
  budgetUsd: "1000.000000",
  isDefault: false,
  usedUsd: "412.800000",
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
};

const CONNECTION: Schemas.SettingsConnection = {
  publicId: "conn_prod",
  environment: Schemas.CompanyConnectionEnvironmentIntEnum.Production,
  environmentLabel: Schemas.CompanyConnectionEnvironmentLabelEnum.Production,
  status: Schemas.CompanyConnectionStatusIntEnum.Active,
  statusLabel: Schemas.CompanyConnectionStatusLabelEnum.Active,
  jwtIssuer: "https://api.eregister.example",
  allowedOrigins: ["https://app.eregister.example"],
  signingKeysFetchedAt: null,
  baseUrl: "https://api.eregister.example/v1",
  signInLabel: "Forward the user's token",
};

const TEAM: Schemas.Team = {
  members: [
    {
      clerkUserId: "user_ana",
      name: "Ana Ruiz",
      email: "ana@northfield.example",
      isYou: true,
      lastActiveAt: new Date().toISOString(),
      createdAt: "2026-09-01T09:00:00.000Z",
    },
    {
      clerkUserId: "user_marcus",
      name: "Marcus Lee",
      email: "marcus@northfield.example",
      isYou: false,
      lastActiveAt: null,
      createdAt: "2026-09-02T09:00:00.000Z",
    },
  ],
  invites: [
    {
      publicId: "inv_priya",
      email: "priya@northfield.example",
      status: Schemas.AdminInviteStatusIntEnum.Pending,
      statusLabel: Schemas.AdminInviteStatusLabelEnum.Pending,
      isEmailed: true,
      invitedByName: "Ana Ruiz",
      createdAt: "2026-10-28T09:00:00.000Z",
    },
  ],
  isLastActiveKnown: true,
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

// DEV_NOTE: Every read and write the two pages make, answered from fixtures
function defaultApi(url: string, init: RequestInit | undefined): { status: number; body: unknown } {
  const method = init?.method ?? "GET";
  if (url.endsWith("/dashboard/settings/model-keys") && method === "GET") {
    return { status: 200, body: { isSuccess: true, modelKeys: [GOOGLE_KEY] } };
  }
  if (url.endsWith("/dashboard/settings/model-keys") && method === "POST") {
    return { status: 201, body: { isSuccess: true, modelKey: ANTHROPIC_KEY } };
  }
  if (url.includes("/dashboard/settings/model-keys/key_google/rotate")) {
    return {
      status: 200,
      body: {
        isSuccess: true,
        modelKey: {
          ...GOOGLE_KEY,
          lastFourChars: "7781",
          status: Schemas.CompanySecretStatusIntEnum.Active,
          statusLabel: Schemas.CompanySecretStatusLabelEnum.Active,
          rotatedAt: "2026-10-28T09:00:00.000Z",
        },
      },
    };
  }
  if (url.endsWith("/dashboard/settings/budget") && method === "GET") {
    return { status: 200, body: { isSuccess: true, spendingBudget: BUDGET } };
  }
  if (url.endsWith("/dashboard/settings/budget") && method === "PUT") {
    const { spendingBudgetUsd } = JSON.parse(String(init?.body)) as { spendingBudgetUsd: number };
    return {
      status: 200,
      body: {
        isSuccess: true,
        spendingBudget: { ...BUDGET, budgetUsd: spendingBudgetUsd.toFixed(6) },
      },
    };
  }
  if (url.endsWith("/dashboard/settings/connections")) {
    return { status: 200, body: { isSuccess: true, connections: [CONNECTION] } };
  }
  if (url.includes("/dashboard/security/connections/conn_prod/origins")) {
    const { allowedOrigins } = JSON.parse(String(init?.body)) as { allowedOrigins: string[] };
    return {
      status: 200,
      body: {
        isSuccess: true,
        connection: { ...CONNECTION, baseUrl: undefined, signInLabel: undefined, allowedOrigins },
      },
    };
  }
  if (url.endsWith("/dashboard/settings/team")) {
    return { status: 200, body: { isSuccess: true, team: TEAM } };
  }
  if (url.endsWith("/dashboard/settings/team/invites")) {
    const { email } = JSON.parse(String(init?.body)) as { email: string };
    return {
      status: 201,
      body: {
        isSuccess: true,
        invite: { ...TEAM.invites[0], publicId: "inv_new", email, isEmailed: false },
      },
    };
  }
  if (url.includes("/dashboard/settings/team/invites/inv_priya/revoke")) {
    return { status: 200, body: { isSuccess: true } };
  }
  if (url.includes("/dashboard/settings/team/admins/user_marcus") && method === "DELETE") {
    return { status: 200, body: { isSuccess: true } };
  }
  return { status: 404, body: { isSuccess: false, message: `Unhandled ${method} ${url}` } };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/model-keys",
        component: ModelKeysRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/budget",
        component: BudgetRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/connections",
        component: ConnectionsRoute.options.component,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/settings/team",
        component: TeamRoute.options.component,
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
  return queryClient;
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

describe("Settings › Model keys", () => {
  it("lists the keys by their last four characters and says a key is needed", async () => {
    mockApi();
    renderPage("/settings/model-keys");

    const keys = await screen.findByRole("region", { name: "Model keys" });
    expect(await within(keys).findByText("Google")).toBeInTheDocument();
    expect(within(keys).getByText("…4417")).toBeInTheDocument();
    expect(within(keys).getByText("Invalid")).toBeInTheDocument();
    // DEV_NOTE: No Active key: the banner asks for one before publishing
    expect(screen.getByText(/Add one before you publish a bot/)).toBeInTheDocument();
  });

  it("adds a key checked by the provider, and shows a refusal without closing", async () => {
    let isRejected = true;
    const fetchMock = mockApi((url, init) => {
      if (url.endsWith("/dashboard/settings/model-keys") && init?.method === "POST" && isRejected) {
        isRejected = false;
        return {
          status: 400,
          body: { isSuccess: false, failure: Schemas.ModelKeyFailureEnum.KeyRejected },
        };
      }
      return null;
    });
    renderPage("/settings/model-keys");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Add key" }));
    const dialog = await screen.findByRole("dialog");
    const keyInput = within(dialog).getByLabelText("Key");
    expect(keyInput).toHaveAttribute("type", "password");
    await user.type(keyInput, NEW_KEY);
    await user.click(within(dialog).getByRole("button", { name: "Check and add" }));

    expect(
      await within(dialog).findByText(
        "The provider rejected this key. Check it and paste it again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // DEV_NOTE: Shown in the dialog only, not toasted as well
    expect(toast.error).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Check and add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const posts = calls(fetchMock, "POST", "/dashboard/settings/model-keys");
    expect(JSON.parse(String(posts[1]?.[1]?.body))).toEqual({
      provider: Schemas.ModelProviderEnum.Anthropic,
      secret: NEW_KEY,
    });

    const keys = screen.getByRole("region", { name: "Model keys" });
    expect(await within(keys).findByText("Anthropic")).toBeInTheDocument();
    expect(screen.queryByText(NEW_KEY)).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Anthropic key added and checked.");
  });

  it("rotates a key and shows it Active with its new last four characters", async () => {
    const fetchMock = mockApi();
    renderPage("/settings/model-keys");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Rotate Google key" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate Google key" });
    await user.type(within(dialog).getByLabelText("Key"), ROTATED_KEY);
    await user.click(within(dialog).getByRole("button", { name: "Check and rotate" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(JSON.parse(String(calls(fetchMock, "POST", "/rotate")[0]?.[1]?.body))).toEqual({
      secret: ROTATED_KEY,
    });
    const keys = screen.getByRole("region", { name: "Model keys" });
    expect(await within(keys).findByText("…7781")).toBeInTheDocument();
    expect(within(keys).getByText("Active")).toBeInTheDocument();
  });

  it("shows an error with a retry when the keys don't load", async () => {
    mockApi((url) =>
      url.endsWith("/dashboard/settings/model-keys")
        ? { status: 500, body: { isSuccess: false } }
        : null,
    );
    renderPage("/settings/model-keys");

    expect(await screen.findByText("Model keys didn't load")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again|Retry/ })).toBeInTheDocument();
  });
});

describe("Settings › Budget", () => {
  it("shows the budget, this period's spend and its share", async () => {
    mockApi();
    renderPage("/settings/budget");

    expect(await screen.findByLabelText("Budget per billing period (USD)")).toHaveValue("1000.00");
    expect(screen.getByText(/\$412\.80 used/)).toBeInTheDocument();
    expect(screen.getByText(/41%/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "41% of the budget used" })).toBeInTheDocument();
    expect(screen.getByText(/1 Oct – 31 Oct/)).toBeInTheDocument();
    expect(screen.queryByText(/Alerts at 50%/)).not.toBeInTheDocument();
  });

  it("saves a whole-cents amount and refuses anything else", async () => {
    const fetchMock = mockApi();
    renderPage("/settings/budget");
    const user = userEvent.setup();

    const amount = await screen.findByLabelText("Budget per billing period (USD)");
    const save = screen.getByRole("button", { name: "Save budget" });
    expect(save).toBeDisabled();
    // DEV_NOTE: The saved amount typed another way isn't a change
    await user.clear(amount);
    await user.type(amount, "1000");
    expect(save).toBeDisabled();

    await user.clear(amount);
    await user.type(amount, "12.345");
    expect(await screen.findByText("Whole cents only")).toBeInTheDocument();
    expect(save).toBeDisabled();

    await user.clear(amount);
    await user.type(amount, "1500.50");
    await user.click(save);

    await waitFor(() =>
      expect(calls(fetchMock, "PUT", "/dashboard/settings/budget")).toHaveLength(1),
    );
    expect(
      JSON.parse(String(calls(fetchMock, "PUT", "/dashboard/settings/budget")[0]?.[1]?.body)),
    ).toEqual({ spendingBudgetUsd: 1500.5 });
    expect(await screen.findByText(/28%/)).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Budget saved. It applies within a minute.");
  });
});

describe("Settings › Connections", () => {
  it("shows each connection's address, sign-in and origins, and edits the origins", async () => {
    const fetchMock = mockApi();
    renderPage("/settings/connections");
    const user = userEvent.setup();

    const card = await screen.findByRole("group", { name: "Production connection" });
    expect(within(card).getByText("https://api.eregister.example/v1")).toBeInTheDocument();
    expect(within(card).getByText("Forward the user's token")).toBeInTheDocument();
    expect(within(card).getByText("app.eregister.example")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Edit Production origins" }));
    const dialog = await screen.findByRole("dialog");
    const origins = within(dialog).getByLabelText("Origins");
    await user.clear(origins);
    await user.type(origins, "https://app.eregister.example{enter}https://help.eregister.example");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(JSON.parse(String(calls(fetchMock, "PUT", "/origins")[0]?.[1]?.body))).toEqual({
      allowedOrigins: ["https://app.eregister.example", "https://help.eregister.example"],
    });
    expect(await within(card).findByText("help.eregister.example")).toBeInTheDocument();
    // DEV_NOTE: The answer is the Security view: the card keeps its address
    expect(within(card).getByText("https://api.eregister.example/v1")).toBeInTheDocument();
  });
});

describe("Settings › Team", () => {
  it("lists the admins and the pending invites", async () => {
    mockApi();
    renderPage("/settings/team");

    const team = await screen.findByRole("region", { name: "Team" });
    expect(await within(team).findByText("Ana Ruiz")).toBeInTheDocument();
    expect(within(team).getByText("(you)")).toBeInTheDocument();
    expect(within(team).getByText("Not yet")).toBeInTheDocument();
    expect(within(team).getByText("priya@northfield.example")).toBeInTheDocument();
    expect(within(team).getByText("Invited")).toBeInTheDocument();
    // DEV_NOTE: No actions on your own row
    expect(within(team).queryByRole("button", { name: "Actions for Ana Ruiz" })).toBeNull();
  });

  it("invites, showing a refusal inline, then says when no email was sent", async () => {
    let isRefused = true;
    const fetchMock = mockApi((url, init) => {
      if (url.endsWith("/team/invites") && init?.method === "POST" && isRefused) {
        isRefused = false;
        return {
          status: 409,
          body: { isSuccess: false, failure: Schemas.TeamFailureEnum.AlreadyAdmin },
        };
      }
      return null;
    });
    renderPage("/settings/team");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Invite" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Email"), "jo@northfield.example");
    await user.click(within(dialog).getByRole("button", { name: "Send invite" }));
    expect(
      await within(dialog).findByText(
        "This person is already an admin, here or for another company.",
      ),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(JSON.parse(String(calls(fetchMock, "POST", "/team/invites")[1]?.[1]?.body))).toEqual({
      email: "jo@northfield.example",
    });
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining("No email was sent, so let them know."),
    );
  });

  it("revokes an invite and removes an admin after confirming", async () => {
    const fetchMock = mockApi();
    renderPage("/settings/team");
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Actions for priya@northfield.example" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Revoke invite" }));
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(calls(fetchMock, "POST", "/inv_priya/revoke")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Actions for Marcus Lee" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove from team" }));
    expect(await screen.findByText("Remove Marcus Lee?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(calls(fetchMock, "DELETE", "/team/admins/user_marcus")).toHaveLength(1),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Admin removed. They lose access from their next page load.",
    );
  });
});

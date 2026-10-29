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

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
import { Route as BotsRoute } from "@/routes/_authenticated/settings/bots/index";
import { Route as VersionRoute } from "@/routes/_authenticated/settings/bots/$id/versions/$versionId/index";
import { Route as NewVersionRoute } from "@/routes/_authenticated/settings/bots/$id/versions/new/index";
import {
  checkConfigBody,
  toConfigBodyInput,
  toConfigFormValues,
} from "@/routes/_authenticated/settings/bots/-configForm";

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

const BODY: Schemas.ConfigSpecBody = Schemas.ZConfigSpecBody.parse({
  persona: { instructions: "You help with registers." },
  procedures: [],
  tools: [{ name: "get_record", version: 1 }],
  approvalRules: [],
  routing: {
    small: { provider: Schemas.ModelProviderEnum.Google, model: "gemini-3.5-flash" },
    mid: { provider: Schemas.ModelProviderEnum.Google, model: "gemini-3.8-flash" },
    top: { provider: Schemas.ModelProviderEnum.Google, model: "gemini-3.1-pro-preview" },
    defaultTier: Schemas.ModelTierEnum.Mid,
  },
  knowledge: { sourceIds: ["ks_1"] },
  widget: { greeting: "Hi, what do you need?", suggestions: ["Which inspections are overdue?"] },
  limits: { maxStepsPerTurn: 20 },
});

const BOT: Schemas.ChatbotSettingsRow = {
  publicId: "bot_1",
  name: "eRegister Assistant",
  status: Schemas.ChatbotStatusIntEnum.Active,
  chatbotStatus: Schemas.ChatbotStatusIntEnum.Active,
  chatbotStatusLabel: Schemas.ChatbotStatusLabelEnum.Active,
  isDefault: true,
  createdAt: new Date("2026-09-01T09:00:00.000Z"),
  updatedAt: new Date("2026-09-01T09:00:00.000Z"),
  liveConfig: { publicId: "cfg_12", configVersion: 12 },
  draftConfig: { publicId: "cfg_13", configVersion: 13 },
  conversationCount: 1486,
};

function version(
  publicId: string,
  configVersion: number,
  status: Schemas.ChatbotConfigStatusIntEnum,
  testResult: Schemas.ChatbotConfigTestResultEnum,
): Schemas.ChatbotConfigDetail {
  return {
    publicId,
    configVersion,
    schemaVersion: 1,
    chatbotConfigStatus: status,
    chatbotConfigStatusLabel: Schemas.CHATBOT_CONFIG_STATUS_LABEL_MAP[status],
    editedByName: "Ana Ruiz",
    testResult,
    publishedAt:
      status === Schemas.ChatbotConfigStatusIntEnum.Published ? "2026-09-28T10:00:00.000Z" : null,
    createdAt: "2026-09-28T09:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    chatbotPublicId: BOT.publicId,
    body: BODY,
    bodyIssue: null,
    failedSafetyCaseCount: 0,
  };
}

const V13 = version(
  "cfg_13",
  13,
  Schemas.ChatbotConfigStatusIntEnum.Draft,
  Schemas.ChatbotConfigTestResultEnum.Failed,
);
const V12 = version(
  "cfg_12",
  12,
  Schemas.ChatbotConfigStatusIntEnum.Published,
  Schemas.ChatbotConfigTestResultEnum.Passed,
);

const OPTIONS: Schemas.ChatbotConfigOptions = {
  tools: [
    {
      name: "get_record",
      version: 1,
      description: "Read one record",
      risk: Schemas.ToolDefinitionRiskIntEnum.Read,
      riskLabel: Schemas.ToolDefinitionRiskLabelEnum.Read,
    },
  ],
  knowledgeSources: [{ publicId: "ks_1", name: "Help center" }],
  activeKeyProviders: [],
};

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

function mockApi(handler: Handler = () => null, bot: Schemas.ChatbotSettingsRow = BOT) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(url, init) ?? defaultApi(url, init, bot);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// DEV_NOTE: Every read and write the Bots pages make, answered from fixtures
function defaultApi(
  url: string,
  init: RequestInit | undefined,
  bot: Schemas.ChatbotSettingsRow,
): { status: number; body: unknown } {
  const method = init?.method ?? "GET";
  if (url.endsWith("/dashboard/chatbots/settings")) {
    return { status: 200, body: { isSuccess: true, chatbots: [bot] } };
  }
  if (url.endsWith("/config-options")) {
    return { status: 200, body: { isSuccess: true, options: OPTIONS } };
  }
  if (url.endsWith("/settings/read-only")) {
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Schemas.UpdateReadOnlyModeApiRequest;
      return { status: 200, body: { isSuccess: true, readOnlyMode: body } };
    }
    return { status: 200, body: { isSuccess: true, readOnlyMode: { isReadOnly: false } } };
  }
  if (url.endsWith("/configs/count")) {
    return { status: 200, body: { isSuccess: true, totalRecords: 2 } };
  }
  if (url.includes("/configs?")) {
    const strip = ({
      body: _body,
      bodyIssue: _issue,
      chatbotPublicId: _bot,
      failedSafetyCaseCount: _safety,
      ...row
    }: Schemas.ChatbotConfigDetail) => row;
    return { status: 200, body: { isSuccess: true, chatbotConfigs: [strip(V13), strip(V12)] } };
  }
  if (url.endsWith("/configs/cfg_12/copy")) {
    return {
      status: 201,
      body: { isSuccess: true, chatbotConfig: { ...V13, publicId: "cfg_14", configVersion: 14 } },
    };
  }
  if (url.endsWith("/configs/cfg_13/send-to-testing")) {
    return {
      status: 409,
      body: {
        isSuccess: false,
        message: "Add a working model key for Google before publishing",
        failure: Schemas.ChatbotConfigFailureEnum.ModelKeyMissing,
        missingKeyProviders: [Schemas.ModelProviderEnum.Google],
      },
    };
  }
  if (url.endsWith("/configs/cfg_13") && method === "PUT") {
    const { body } = JSON.parse(String(init?.body)) as { body: Schemas.ConfigSpecBody };
    return { status: 200, body: { isSuccess: true, chatbotConfig: { ...V13, body } } };
  }
  if (url.endsWith("/configs/cfg_13"))
    return { status: 200, body: { isSuccess: true, chatbotConfig: V13 } };
  if (url.endsWith("/configs/cfg_12"))
    return { status: 200, body: { isSuccess: true, chatbotConfig: V12 } };
  if (url.endsWith("/configs/cfg_14")) {
    return {
      status: 200,
      body: { isSuccess: true, chatbotConfig: { ...V13, publicId: "cfg_14", configVersion: 14 } },
    };
  }
  return { status: 404, body: { isSuccess: false, message: "Not found" } };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const route = (to: string, options: { validateSearch?: unknown; component: unknown }) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: to,
      ...(options as object),
    });
  const stub = (to: string) =>
    createRoute({ getParentRoute: () => rootRoute, path: to, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      route("/settings/bots", {
        validateSearch: BotsRoute.options.validateSearch,
        component: BotsRoute.options.component,
      }),
      route("/settings/bots/$id/versions/new", { component: NewVersionRoute.options.component }),
      route("/settings/bots/$id/versions/$versionId", {
        component: VersionRoute.options.component,
      }),
      stub("/settings/model-keys"),
      stub("/knowledge"),
      stub("/tests"),
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
  vi.unstubAllGlobals();
  toast.error.mockReset();
  toast.success.mockReset();
});

describe("Settings › Bots", () => {
  it("lists the bots and the default bot's versions with their tests", async () => {
    mockApi();
    renderPage("/settings/bots");

    const bots = await screen.findByRole("region", { name: "Bots" });
    expect(await within(bots).findByText("eRegister Assistant")).toBeInTheDocument();
    expect(within(bots).getByText("Default")).toBeInTheDocument();
    expect(within(bots).getByText("v12")).toBeInTheDocument();
    expect(within(bots).getByText("1,486")).toBeInTheDocument();

    const versions = await screen.findByRole("region", { name: "Versions of eRegister Assistant" });
    expect(await within(versions).findByText("v13")).toBeInTheDocument();
    expect(within(versions).getByText("Draft")).toBeInTheDocument();
    expect(within(versions).getByText("Published")).toBeInTheDocument();
    expect(within(versions).getByText("Failed")).toBeInTheDocument();
    expect(within(versions).getByText("Passed")).toBeInTheDocument();
  });

  it("turns read-only mode on", async () => {
    const fetchMock = mockApi();
    renderPage("/settings/bots");

    const toggle = await screen.findByRole("switch", { name: "Read-only mode" });
    await userEvent.click(toggle);
    await waitFor(() => expect(calls(fetchMock, "PUT", "/settings/read-only")).toHaveLength(1));
    const [, init] = calls(fetchMock, "PUT", "/settings/read-only")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ isReadOnly: true });
    expect(toast.success).toHaveBeenCalledWith(
      "Read-only mode is on. Changes to your data are blocked for every bot.",
    );
  });

  it("opens the open draft, and copies the live version when there is none", async () => {
    const fetchMock = mockApi(() => null, { ...BOT, draftConfig: null });
    const router = renderPage("/settings/bots");

    const versions = await screen.findByRole("region", { name: "Versions of eRegister Assistant" });
    await userEvent.click(within(versions).getByRole("button", { name: "Open draft" }));
    await waitFor(() => expect(calls(fetchMock, "POST", "/configs/cfg_12/copy")).toHaveLength(1));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/bots/bot_1/versions/cfg_14"),
    );
  });
});

describe("Settings › Bots › version", () => {
  it("saves a draft's edits as a config body", async () => {
    const fetchMock = mockApi();
    renderPage("/settings/bots/bot_1/versions/cfg_13");

    const instructions = await screen.findByRole("textbox", { name: "Instructions" });
    await userEvent.clear(instructions);
    await userEvent.type(instructions, "You answer questions about registers.");
    expect(screen.getByRole("button", { name: "Send to testing" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(calls(fetchMock, "PUT", "/configs/cfg_13")).toHaveLength(1));
    const [, init] = calls(fetchMock, "PUT", "/configs/cfg_13")[0]!;
    const { body } = JSON.parse(String(init?.body)) as { body: Schemas.ConfigSpecBody };
    expect(body.persona.instructions).toBe("You answer questions about registers.");
    expect(body.limits).toEqual({ maxStepsPerTurn: 20 });
    expect(body.widget.suggestions).toEqual(["Which inspections are overdue?"]);
    expect(toast.success).toHaveBeenCalledWith("Draft saved.");
  });

  it("warns that publishing needs a model key, and shows the send to testing refusal", async () => {
    mockApi();
    renderPage("/settings/bots/bot_1/versions/cfg_13");

    expect(
      await screen.findByText("Add a working model key for Google before publishing."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send to testing" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Send v13 to testing?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send to testing" }));

    expect(await screen.findByText("This version wasn't sent to testing")).toBeInTheDocument();
    expect(
      screen.getByText("Add a working model key for Google before publishing"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Model keys" })).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(
      "Add a working model key for Google before publishing Nothing changed.",
    );
  });

  it("sends a draft to testing, and locks it there with only Back to draft", async () => {
    const testing = {
      ...V13,
      chatbotConfigStatus: Schemas.ChatbotConfigStatusIntEnum.Testing,
      chatbotConfigStatusLabel: Schemas.ChatbotConfigStatusLabelEnum.Testing,
    };
    let current = V13;
    const fetchMock = mockApi((url, init) => {
      if (url.endsWith("/configs/cfg_13/send-to-testing")) {
        current = testing;
        return { status: 200, body: { isSuccess: true, chatbotConfig: testing } };
      }
      if (url.endsWith("/configs/cfg_13/back-to-draft")) {
        current = V13;
        return { status: 200, body: { isSuccess: true, chatbotConfig: V13 } };
      }
      if (url.endsWith("/configs/cfg_13") && (init?.method ?? "GET") === "GET") {
        return { status: 200, body: { isSuccess: true, chatbotConfig: current } };
      }
      return null;
    });
    renderPage("/settings/bots/bot_1/versions/cfg_13");

    await userEvent.click(await screen.findByRole("button", { name: "Send to testing" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Send v13 to testing?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Send to testing" }));
    await waitFor(() =>
      expect(calls(fetchMock, "POST", "/configs/cfg_13/send-to-testing")).toHaveLength(1),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "v13 is in testing. It's ready to publish once its tests pass.",
    );
    expect(await screen.findByRole("button", { name: "Back to draft" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send to testing" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Back to draft" }));
    const back = await screen.findByRole("alertdialog", { name: "Move v13 back to draft?" });
    await userEvent.click(within(back).getByRole("button", { name: "Back to draft" }));
    await waitFor(() =>
      expect(calls(fetchMock, "POST", "/configs/cfg_13/back-to-draft")).toHaveLength(1),
    );
  });

  it("publishes a version that passed its tests", async () => {
    const ready = {
      ...V13,
      chatbotConfigStatus: Schemas.ChatbotConfigStatusIntEnum.Ready,
      chatbotConfigStatusLabel: Schemas.ChatbotConfigStatusLabelEnum.Ready,
      testResult: Schemas.ChatbotConfigTestResultEnum.Passed,
    };
    const published = {
      ...ready,
      chatbotConfigStatus: Schemas.ChatbotConfigStatusIntEnum.Published,
      chatbotConfigStatusLabel: Schemas.ChatbotConfigStatusLabelEnum.Published,
    };
    const fetchMock = mockApi((url, init) => {
      if (url.endsWith("/configs/cfg_13/publish")) {
        return { status: 200, body: { isSuccess: true, chatbotConfig: published } };
      }
      if (url.endsWith("/configs/cfg_13") && (init?.method ?? "GET") === "GET") {
        return { status: 200, body: { isSuccess: true, chatbotConfig: ready } };
      }
      return null;
    });
    renderPage("/settings/bots/bot_1/versions/cfg_13");

    await userEvent.click(await screen.findByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Publish v13?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(calls(fetchMock, "POST", "/configs/cfg_13/publish")).toHaveLength(1),
    );
    expect(toast.success).toHaveBeenCalledWith(
      "v13 is live. The assistant uses it from the next message.",
    );
  });

  it("says a failed safety case blocks publishing", async () => {
    mockApi((url, init) =>
      url.endsWith("/configs/cfg_13") && (init?.method ?? "GET") === "GET"
        ? {
            status: 200,
            body: { isSuccess: true, chatbotConfig: { ...V13, failedSafetyCaseCount: 1 } },
          }
        : null,
    );
    renderPage("/settings/bots/bot_1/versions/cfg_13");

    expect(await screen.findByText("A failed safety case blocks publishing")).toBeInTheDocument();
    expect(
      screen.getByText(/1 safety case failed in this version's last test run/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See the test run" })).toBeInTheDocument();
  });

  it("shows a published version read-only, with Open draft while one exists", async () => {
    mockApi();
    renderPage("/settings/bots/bot_1/versions/cfg_12");

    expect(await screen.findByRole("textbox", { name: "Instructions" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open draft v13" })).toBeInTheDocument();
  });
});

describe("Config form values", () => {
  it("round-trips a stored body unchanged", () => {
    const values = toConfigFormValues(BODY, OPTIONS);
    expect(Schemas.ZConfigSpecBody.parse(toConfigBodyInput(values, BODY.attachments))).toEqual(
      BODY,
    );
  });

  it("starts a blank draft on the suggested models of the first provider with a key", () => {
    const values = toConfigFormValues(null, {
      ...OPTIONS,
      activeKeyProviders: [Schemas.ModelProviderEnum.OpenAI],
    });
    expect(values.routing.mid).toEqual({
      provider: Schemas.ModelProviderEnum.OpenAI,
      model:
        Schemas.MODEL_TIER_SUGGESTIONS[Schemas.ModelProviderEnum.OpenAI][Schemas.ModelTierEnum.Mid],
    });
    expect(values.suggestions).toEqual(["", "", ""]);
  });

  // DEV_NOTE: An empty rule tools list means every tool, so unpinning a rule's only tool must not widen the rule
  it("never turns a rule for removed tools into a rule for every tool", () => {
    const values = toConfigFormValues(
      Schemas.ZConfigSpecBody.parse({
        ...BODY,
        tools: [
          { name: "get_record", version: 1 },
          { name: "update_record", version: 1 },
        ],
        approvalRules: [
          {
            roles: ["support"],
            tools: ["get_record"],
            approval: Schemas.ApprovalRuleApprovalEnum.Auto,
          },
          {
            roles: ["support"],
            tools: ["get_record", "update_record"],
            approval: Schemas.ApprovalRuleApprovalEnum.Required,
          },
        ],
      }),
      OPTIONS,
    );
    const unpinned = {
      ...values,
      tools: values.tools.filter((tool) => tool.name !== "get_record"),
    };

    const input = toConfigBodyInput(unpinned, BODY.attachments);
    expect(input.approvalRules?.map((rule) => rule.tools)).toEqual([
      ["get_record"],
      ["update_record"],
    ]);
    const checked = checkConfigBody(input);
    expect(checked.body).toBeNull();
    expect(checked.issues).toEqual([
      'Approval rules (#1 › tools › #1): Approval rule names tool "get_record", which is not pinned in tools',
    ]);
  });
});

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
import { Route as KnowledgeRoute } from "@/routes/_authenticated/knowledge/index";
import { Route as KnowledgeSourceRoute } from "@/routes/_authenticated/knowledge/$id/index";

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

const HELP_CENTER: Schemas.KnowledgeSourceListItem = {
  publicId: "ks_help",
  name: "Help center",
  type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap,
  typeLabel: Schemas.KnowledgeSourceTypeLabelEnum.Sitemap,
  url: "https://help.eregister.com/sitemap.xml",
  syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
  syncFrequencyLabel: Schemas.KnowledgeSourceSyncFrequencyLabelEnum.Daily,
  status: Schemas.KnowledgeSourceStatusIntEnum.Failed,
  knowledgeSourceStatus: Schemas.KnowledgeSourceStatusIntEnum.Failed,
  knowledgeSourceStatusLabel: Schemas.KnowledgeSourceStatusLabelEnum.Failed,
  lastSyncedAt: new Date("2026-10-01T09:00:00.000Z"),
  syncHeartbeatAt: null,
  createdAt: new Date("2026-09-01T09:00:00.000Z"),
  updatedAt: new Date("2026-10-01T09:00:00.000Z"),
  documentCount: 214,
};

const UPLOADS: Schemas.KnowledgeSourceListItem = {
  ...HELP_CENTER,
  publicId: "ks_up",
  name: "Uploaded procedures",
  type: Schemas.KnowledgeSourceTypeIntEnum.Upload,
  typeLabel: Schemas.KnowledgeSourceTypeLabelEnum.Upload,
  url: null,
  syncFrequency: null,
  syncFrequencyLabel: null,
  status: Schemas.KnowledgeSourceStatusIntEnum.Active,
  knowledgeSourceStatus: Schemas.KnowledgeSourceStatusIntEnum.Active,
  knowledgeSourceStatusLabel: Schemas.KnowledgeSourceStatusLabelEnum.Active,
  documentCount: 12,
};

const OPEN_CLUSTER: Schemas.DocGapClusterListItem = {
  publicId: "gap_1",
  label: "Uploading contractor insurance certificates",
  questionCount: 14,
  docGapClusterStatus: Schemas.DocGapClusterStatusIntEnum.Open,
  docGapClusterStatusLabel: Schemas.DocGapClusterStatusLabelEnum.Open,
  latestQuestionAt: new Date().toISOString(),
  sampleQuestions: [
    "Where do insurance certificates go?",
    "Can a contractor upload their own certificate?",
  ],
  answeredBy: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
};

const ANSWERED_CLUSTER: Schemas.DocGapClusterListItem = {
  ...OPEN_CLUSTER,
  publicId: "gap_2",
  label: "Archiving a whole register",
  questionCount: 6,
  docGapClusterStatus: Schemas.DocGapClusterStatusIntEnum.Answered,
  docGapClusterStatusLabel: Schemas.DocGapClusterStatusLabelEnum.Answered,
  answeredBy: {
    documentPublicId: "doc_archive",
    title: "Archiving a register",
    sourceUrl: "https://help.eregister.com/archiving",
    knowledgeSource: { publicId: "ks_help", name: "Help center" },
  },
};

const DOCUMENT: Schemas.KnowledgeDocumentWithStatus = {
  publicId: "doc_cert",
  title: "Insurance certificates.pdf",
  sourceUrl: null,
  indexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
  knowledgeDocumentIndexStatus: Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed,
  knowledgeDocumentIndexStatusLabel: Schemas.KnowledgeDocumentIndexStatusLabelEnum.Indexed,
  lastSyncedAt: new Date("2026-10-01T09:00:00.000Z"),
  createdAt: new Date("2026-10-01T09:00:00.000Z"),
  updatedAt: new Date("2026-10-01T09:00:00.000Z"),
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

// DEV_NOTE: Every read and write the Knowledge pages make, answered from fixtures
function defaultApi(url: string, init?: RequestInit): { status: number; body: unknown } {
  const method = init?.method ?? "GET";
  if (url.includes("/dashboard/doc-gap-clusters")) {
    if (method === "POST") {
      return { status: 200, body: { isSuccess: true, docGapCluster: OPEN_CLUSTER } };
    }
    const isAnswered = url.includes("tab=answered");
    return {
      status: 200,
      body: {
        isSuccess: true,
        docGapClusters: isAnswered ? [ANSWERED_CLUSTER] : [OPEN_CLUSTER],
        totalRecords: 1,
        tabCounts: { open: 1, answered: 1, dismissed: 0 },
      },
    };
  }
  if (url.includes("/documents/count"))
    return { status: 200, body: { isSuccess: true, totalRecords: 1 } };
  if (url.includes("/documents")) {
    if (method === "POST") {
      return {
        status: 201,
        body: { isSuccess: true, knowledgeDocument: { ...DOCUMENT, publicId: "doc_new" } },
      };
    }
    if (method === "DELETE") return { status: 200, body: { isSuccess: true } };
    return { status: 200, body: { isSuccess: true, knowledgeDocuments: [DOCUMENT] } };
  }
  if (url.endsWith("/sync")) {
    return { status: 200, body: { isSuccess: true, knowledgeSource: HELP_CENTER } };
  }
  if (url.endsWith("/knowledge-sources/count")) {
    return { status: 200, body: { isSuccess: true, totalRecords: 2 } };
  }
  if (url.includes("/knowledge-sources/ks_up")) {
    return { status: 200, body: { isSuccess: true, knowledgeSource: UPLOADS } };
  }
  if (method === "POST" && url.endsWith("/knowledge-sources")) {
    return { status: 201, body: { isSuccess: true, knowledgeSource: UPLOADS } };
  }
  return { status: 200, body: { isSuccess: true, knowledgeSources: [HELP_CENTER, UPLOADS] } };
}

function renderPage(path: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const pages = [
    ["/knowledge", KnowledgeRoute],
    ["/knowledge/$id", KnowledgeSourceRoute],
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

describe("Knowledge sources", () => {
  it("lists each source with its type, address, status, documents and re-sync", async () => {
    mockApi();
    renderPage("/knowledge");

    const help = await screen.findByRole("link", { name: "Help center" });
    const helpRow = help.closest("tr")!;
    expect(within(helpRow).getByText("help.eregister.com/sitemap.xml")).toBeInTheDocument();
    expect(within(helpRow).getByText("Failed")).toBeInTheDocument();
    expect(within(helpRow).getByText("214")).toBeInTheDocument();
    expect(within(helpRow).getByText("Daily")).toBeInTheDocument();

    const uploadRow = screen.getByRole("link", { name: "Uploaded procedures" }).closest("tr")!;
    expect(within(uploadRow).getByText("12 files")).toBeInTheDocument();
    expect(within(uploadRow).getByText("—")).toBeInTheDocument();
  });

  it("shows a banner for a failed source and retries its sync", async () => {
    const fetchMock = mockApi();
    renderPage("/knowledge");

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(
      /^Help center sync failed\. Answers use the last good copy from 1 Oct\./,
    );
    await userEvent.click(within(banner).getByRole("button", { name: "Retry sync" }));
    await waitFor(() => expect(calls(fetchMock, "POST", "/ks_help/sync")).toHaveLength(1));
    expect(toast.success).toHaveBeenCalledWith("Sync started.");
  });

  it("adds a sitemap source with its name, address and re-sync", async () => {
    const fetchMock = mockApi();
    renderPage("/knowledge");

    await userEvent.click(await screen.findByRole("button", { name: "Add source" }));
    const dialog = await screen.findByRole("dialog", { name: "Add source" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Help center");
    await userEvent.type(
      within(dialog).getByLabelText("Sitemap address"),
      "https://help.example.com/sitemap.xml",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Add source" }));

    await waitFor(() =>
      expect(calls(fetchMock, "POST", "/dashboard/knowledge-sources")).toHaveLength(1),
    );
    const [, init] = calls(fetchMock, "POST", "/dashboard/knowledge-sources")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      knowledgeSource: {
        type: Schemas.KnowledgeSourceTypeIntEnum.Sitemap,
        name: "Help center",
        url: "https://help.example.com/sitemap.xml",
        syncFrequency: Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
      },
    });
    expect(toast.success).toHaveBeenCalledWith("Source added. Its first sync has started.");
  });

  it("refuses an address that isn't a public https page", async () => {
    const fetchMock = mockApi();
    renderPage("/knowledge");

    await userEvent.click(await screen.findByRole("button", { name: "Add source" }));
    const dialog = await screen.findByRole("dialog", { name: "Add source" });
    await userEvent.type(within(dialog).getByLabelText("Name"), "Local");
    await userEvent.type(within(dialog).getByLabelText("Sitemap address"), "http://localhost:8080");
    expect(
      await within(dialog).findByText("Enter a public web address starting with https://"),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add source" })).toBeDisabled();
    expect(calls(fetchMock, "POST", "/dashboard/knowledge-sources")).toHaveLength(0);
  });
});

describe("Questions it couldn't answer", () => {
  it("shows each group's size, newest question and samples, and dismisses one", async () => {
    const fetchMock = mockApi();
    renderPage("/knowledge");

    const label = await screen.findByText("Uploading contractor insurance certificates");
    const row = label.closest("li")!;
    expect(within(row).getByText("14 questions, latest Today")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Open\s*1/ })).toBeInTheDocument();
    expect(within(row).queryByText('"Where do insurance certificates go?"')).toBeNull();

    await userEvent.click(within(row).getByRole("button", { name: "Show questions" }));
    expect(within(row).getByText('"Where do insurance certificates go?"')).toBeInTheDocument();

    await userEvent.click(within(row).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(calls(fetchMock, "POST", "/gap_1/dismiss")).toHaveLength(1));
  });

  it("links an answered group to the document that closed it", async () => {
    mockApi();
    renderPage("/knowledge?tab=answered");

    const link = await screen.findByRole("link", { name: "Archiving a register" });
    expect(link).toHaveAttribute("href", "/knowledge/ks_help");
    const row = link.closest("li")!;
    expect(within(row).getByText("in Help center")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open the page" })).toHaveAttribute(
      "href",
      "https://help.eregister.com/archiving",
    );
    expect(within(row).queryByRole("button", { name: "Add a document" })).toBeNull();
  });

  it("answers a group with an uploaded file", async () => {
    const fetchMock = mockApi();
    renderPage("/knowledge");

    const row = (await screen.findByText(OPEN_CLUSTER.label)).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Add a document" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a document" });
    const file = new File(["# Certificates"], "certificates.md", { type: "text/markdown" });
    await userEvent.upload(await within(dialog).findByLabelText("File"), file);
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark answered" }));

    await waitFor(() => expect(calls(fetchMock, "POST", "/gap_1/answer")).toHaveLength(1));
    const [, uploadInit] = calls(fetchMock, "POST", "/ks_up/documents")[0]!;
    expect(uploadInit?.body).toBeInstanceOf(FormData);
    expect((uploadInit?.body as FormData).get("file")).toBe(file);
    const [, answerInit] = calls(fetchMock, "POST", "/gap_1/answer")[0]!;
    expect(JSON.parse(String(answerInit?.body))).toEqual({ documentPublicId: "doc_new" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add a document" })).toBeNull(),
    );
  });

  it("answers a group with a document picked from a source", async () => {
    const fetchMock = mockApi();
    renderPage("/knowledge");

    const row = (await screen.findByText(OPEN_CLUSTER.label)).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Add a document" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a document" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "Pick a document" }));
    await userEvent.type(within(dialog).getByLabelText("Title"), "insurance");
    await userEvent.click(
      await within(dialog).findByRole("radio", { name: "Insurance certificates.pdf" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark answered" }));

    await waitFor(() => expect(calls(fetchMock, "POST", "/gap_1/answer")).toHaveLength(1));
    const [, answerInit] = calls(fetchMock, "POST", "/gap_1/answer")[0]!;
    expect(JSON.parse(String(answerInit?.body))).toEqual({ documentPublicId: "doc_cert" });
    expect(
      calls(fetchMock, "GET", "/ks_help/documents?").some(([url]) =>
        String(url).includes("search=insurance"),
      ),
    ).toBe(true);
    expect(calls(fetchMock, "POST", "/documents")).toHaveLength(0);
  });

  it("offers an upload source when there is none, and says a closed group changed nothing", async () => {
    mockApi((url, init) => {
      if (url.includes("/answer")) {
        return { status: 409, body: { isSuccess: false, failure: "NotOpen" } };
      }
      if ((init?.method ?? "GET") === "GET" && url.includes("/knowledge-sources?")) {
        return { status: 200, body: { isSuccess: true, knowledgeSources: [HELP_CENTER] } };
      }
      return null;
    });
    renderPage("/knowledge");

    const row = (await screen.findByText(OPEN_CLUSTER.label)).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Add a document" }));
    let dialog = await screen.findByRole("dialog", { name: "Add a document" });
    expect(
      await within(dialog).findByText("Files go into an upload source, and there isn't one yet."),
    ).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("radio", { name: "Pick a document" }));
    await userEvent.click(
      await within(dialog).findByRole("radio", { name: "Insurance certificates.pdf" }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark answered" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This group was already closed. Nothing changed."),
    );

    await userEvent.click(within(dialog).getByRole("radio", { name: "Upload a file" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add an upload source" }));
    dialog = await screen.findByRole("dialog", { name: "Add source" });
    expect(within(dialog).getByRole("combobox", { name: "Type" })).toHaveTextContent("Upload");
  });
});

describe("Knowledge source page", () => {
  it("shows the source and its documents, and removes one after a confirm", async () => {
    const fetchMock = mockApi();
    renderPage("/knowledge/ks_up");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Uploaded procedures" }),
    ).toBeInTheDocument();
    const documentRow = (await screen.findByText("Insurance certificates.pdf")).closest("tr")!;
    expect(within(documentRow).getByText("Ready")).toBeInTheDocument();

    await userEvent.click(
      within(documentRow).getByRole("button", { name: "Remove Insurance certificates.pdf" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(calls(fetchMock, "DELETE", "/ks_up/documents/doc_cert")).toHaveLength(1),
    );
    expect(toast.success).toHaveBeenCalledWith("Document removed.");
  });

  it("says when the source is gone", async () => {
    mockApi((url) =>
      url.includes("/knowledge-sources/ks_gone")
        ? { status: 404, body: { isSuccess: false, isNotFound: true } }
        : null,
    );
    renderPage("/knowledge/ks_gone");
    expect(
      await screen.findByText("This source isn't available. It may have been deleted."),
    ).toBeInTheDocument();
  });
});

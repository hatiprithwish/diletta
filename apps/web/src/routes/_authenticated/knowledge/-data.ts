import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import { QUERY_KEY_ROOTS } from "../-invalidation";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: The Knowledge page (M4-7): the sources with their document counts, one source with its documents, and the
// groups of questions the assistant couldn't answer. keys.all() covers them all. A source write refetches the source
// views and Overview (it counts failed sources, through its QUERY_KEY_ROOTS root); a document write refetches its source and the groups (removing a
// document reopens the group it answered); a group write refetches the groups.
export class KnowledgeQueries {
  static keys = {
    all: () => ["knowledge"] as const,
    sources: () => [...KnowledgeQueries.keys.all(), "sources"] as const,
    sourcesPage: (page: number) => [...KnowledgeQueries.keys.sources(), "page", page] as const,
    sourcesCount: () => [...KnowledgeQueries.keys.sources(), "count"] as const,
    sourceChoices: () => [...KnowledgeQueries.keys.sources(), "choices"] as const,
    failedSources: () => [...KnowledgeQueries.keys.sources(), "failed"] as const,
    // DEV_NOTE: Details sit under their own root, so refetching the lists (keys.sources()) never touches them: a write
    // sets the detail it changed (setQueryData)
    sourceDetails: () => [...KnowledgeQueries.keys.all(), "source"] as const,
    source: (publicId: string) => [...KnowledgeQueries.keys.sourceDetails(), publicId] as const,
    documents: (publicId: string) =>
      [...KnowledgeQueries.keys.all(), "documents", publicId] as const,
    documentsPage: (publicId: string, page: number, search: string) =>
      [...KnowledgeQueries.keys.documents(publicId), "page", page, search] as const,
    documentsCount: (publicId: string, search: string) =>
      [...KnowledgeQueries.keys.documents(publicId), "count", search] as const,
    clusters: () => [...KnowledgeQueries.keys.all(), "clusters"] as const,
    clusterList: (tab: Schemas.DocGapClusterListTabEnum, page: number) =>
      [...KnowledgeQueries.keys.clusters(), tab, page] as const,
  };

  static sourcesPage(page: number, getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(Schemas.KNOWLEDGE_SOURCES_PAGE_SIZE),
      sortDirection: Schemas.SortDirection.Asc,
    });
    return queryOptions({
      queryKey: KnowledgeQueries.keys.sourcesPage(page),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetKnowledgeSourcesApiResponse>(
          `/dashboard/knowledge-sources?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }

  static sourcesCount(getToken: GetToken) {
    return queryOptions({
      queryKey: KnowledgeQueries.keys.sourcesCount(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetKnowledgeSourcesCountApiResponse>(
          "/dashboard/knowledge-sources/count",
          getToken,
          { signal },
        ),
    });
  }

  // DEV_NOTE: The source choices of "Add a document": the company's first MAX_PAGE_SIZE sources, oldest first. A
  // company with more sources can't pick from the rest here (v1: a company has a handful); the source's own page still
  // takes its uploads.
  static sourceChoices(getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: "1",
      pageSize: String(Schemas.MAX_PAGE_SIZE),
      sortDirection: Schemas.SortDirection.Asc,
    });
    return queryOptions({
      queryKey: KnowledgeQueries.keys.sourceChoices(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetKnowledgeSourcesApiResponse>(
          `/dashboard/knowledge-sources?${params.toString()}`,
          getToken,
          { signal },
        ),
    });
  }

  // DEV_NOTE: Every Failed source, whatever page of the table is shown (one banner each). Up to MAX_PAGE_SIZE.
  static failedSources(getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: "1",
      pageSize: String(Schemas.MAX_PAGE_SIZE),
      sortDirection: Schemas.SortDirection.Asc,
      status: String(Schemas.KnowledgeSourceStatusIntEnum.Failed),
    });
    return queryOptions({
      queryKey: KnowledgeQueries.keys.failedSources(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetKnowledgeSourcesApiResponse>(
          `/dashboard/knowledge-sources?${params.toString()}`,
          getToken,
          { signal },
        ),
    });
  }

  static source(publicId: string, getToken: GetToken) {
    return queryOptions({
      queryKey: KnowledgeQueries.keys.source(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetKnowledgeSourceApiResponse>(
          `/dashboard/knowledge-sources/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }

  static documentsPage(
    publicId: string,
    page: number,
    search: string,
    pageSize: number,
    getToken: GetToken,
  ) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(pageSize),
      sortColumn: Schemas.KnowledgeDocumentSortColumn.Title,
      sortDirection: Schemas.SortDirection.Asc,
    });
    if (search) params.set("search", search);
    return queryOptions({
      queryKey: KnowledgeQueries.keys.documentsPage(publicId, page, search),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetKnowledgeDocumentsApiResponse>(
          `/dashboard/knowledge-sources/${encodeURIComponent(publicId)}/documents?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }

  static documentsCount(publicId: string, search: string, getToken: GetToken) {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    return queryOptions({
      queryKey: KnowledgeQueries.keys.documentsCount(publicId, search),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetKnowledgeDocumentsCountApiResponse>(
          `/dashboard/knowledge-sources/${encodeURIComponent(publicId)}/documents/count?${params.toString()}`,
          getToken,
          { signal },
        ),
    });
  }

  static clusterList(tab: Schemas.DocGapClusterListTabEnum, page: number, getToken: GetToken) {
    const params = new URLSearchParams({
      tab,
      pageNo: String(page),
      pageSize: String(Schemas.DOC_GAP_CLUSTERS_PAGE_SIZE),
    });
    return queryOptions({
      queryKey: KnowledgeQueries.keys.clusterList(tab, page),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetDocGapClustersApiResponse>(
          `/dashboard/doc-gap-clusters?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }
}

export function useKnowledgeSources(page: number) {
  const { getToken } = useAuth();
  return useQuery(KnowledgeQueries.sourcesPage(page, getToken));
}

export function useKnowledgeSourcesCount() {
  const { getToken } = useAuth();
  return useQuery(KnowledgeQueries.sourcesCount(getToken));
}

export function useKnowledgeSourceChoices(isEnabled: boolean) {
  const { getToken } = useAuth();
  return useQuery({ ...KnowledgeQueries.sourceChoices(getToken), enabled: isEnabled });
}

export function useFailedKnowledgeSources() {
  const { getToken } = useAuth();
  return useQuery(KnowledgeQueries.failedSources(getToken));
}

export function useKnowledgeSource(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(KnowledgeQueries.source(publicId, getToken));
}

// DEV_NOTE: One source's documents: a page of its table, or the picker's matches (search set, isEnabled while it's open)
export function useKnowledgeDocuments(params: {
  publicId: string;
  page: number;
  search: string;
  pageSize: number;
  isEnabled?: boolean;
}) {
  const { getToken } = useAuth();
  return useQuery({
    ...KnowledgeQueries.documentsPage(
      params.publicId,
      params.page,
      params.search,
      params.pageSize,
      getToken,
    ),
    enabled: (params.isEnabled ?? true) && params.publicId !== "",
  });
}

export function useKnowledgeDocumentsCount(publicId: string, search: string) {
  const { getToken } = useAuth();
  return useQuery(KnowledgeQueries.documentsCount(publicId, search, getToken));
}

export function useDocGapClusters(tab: Schemas.DocGapClusterListTabEnum, page: number) {
  const { getToken } = useAuth();
  return useQuery(KnowledgeQueries.clusterList(tab, page, getToken));
}

// DEV_NOTE: A source changed: its detail shows the answer at once; the lists, the groups (an Answered one names its
// document's source, and a removed source took its documents) and Overview's failed-source count refetch
function applySourceWrite(
  queryClient: QueryClient,
  source: Schemas.KnowledgeSourceWithStatus | undefined,
) {
  if (source) {
    queryClient.setQueryData<Schemas.GetKnowledgeSourceApiResponse>(
      KnowledgeQueries.keys.source(source.publicId),
      (previous) => ({ ...previous, isSuccess: true, knowledgeSource: source }),
    );
  }
  void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.sources() });
  void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.clusters() });
  void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.overview });
}

// DEV_NOTE: A refused or failed source write: the lists and that source's detail refetch to show where it stands
function refetchSource(queryClient: QueryClient, publicId: string) {
  void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.sources() });
  void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.source(publicId) });
}

// DEV_NOTE: Why a source request was refused (409 / 400), in the dashboard's words (DESIGN.md §8)
const SOURCE_FAILURE_TEXT: Record<Schemas.KnowledgeSourceFailureEnum, string> = {
  [Schemas.KnowledgeSourceFailureEnum.AlreadySyncing]: "This source is already syncing.",
  [Schemas.KnowledgeSourceFailureEnum.Paused]: "This source is paused. Resume it to sync.",
  [Schemas.KnowledgeSourceFailureEnum.NotUploadSource]:
    "Files can only be added to an upload source. Nothing changed.",
  [Schemas.KnowledgeSourceFailureEnum.NotWebSource]:
    "Only a website source syncs on a schedule. Nothing changed.",
  [Schemas.KnowledgeSourceFailureEnum.UnreadableFile]:
    "The file doesn't match its type, so it wasn't added.",
};

function sourceFailureText(error: Error, fallback: string): string {
  if (error instanceof ApiError) {
    const failure = (error.body as Schemas.KnowledgeSourceStateResponse).failure;
    if (failure) return SOURCE_FAILURE_TEXT[failure];
    if (error.status === 413) return "The file is too large. Nothing was added.";
    if (error.status === 404) return "This source isn't available. It may have been removed.";
  }
  return fallback;
}

// DEV_NOTE: Add source. The dialog awaits it (mutateAsync): an upload source then gets its files.
export function useCreateKnowledgeSource() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.CreateKnowledgeSourceApiRequest) =>
      apiClient<Schemas.CreateKnowledgeSourceApiResponse>(
        "/dashboard/knowledge-sources",
        getToken,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      ),
    onSuccess: (response) => applySourceWrite(queryClient, response.knowledgeSource),
    onError: () => toast.error("The source wasn't added. Nothing changed, try again."),
  });
}

// DEV_NOTE: Rename, change the re-sync frequency, pause or resume. The edit dialog awaits it (mutateAsync).
export function useUpdateKnowledgeSource(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateKnowledgeSourceApiRequest) =>
      apiClient<Schemas.UpdateKnowledgeSourceApiResponse>(
        `/dashboard/knowledge-sources/${encodeURIComponent(publicId)}`,
        getToken,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => applySourceWrite(queryClient, response.knowledgeSource),
    onError: (error) => {
      toast.error(
        sourceFailureText(error, "The source wasn't updated. Nothing changed, try again."),
      );
      refetchSource(queryClient, publicId);
    },
  });
}

export function useSyncKnowledgeSource(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.SyncKnowledgeSourceApiResponse>(
        `/dashboard/knowledge-sources/${encodeURIComponent(publicId)}/sync`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response) => {
      applySourceWrite(queryClient, response.knowledgeSource);
      toast.success("Sync started.");
    },
    onError: (error) => {
      toast.error(sourceFailureText(error, "The sync didn't start. Try again."));
      refetchSource(queryClient, publicId);
    },
  });
}

// DEV_NOTE: Delete a source with its documents. The confirm dialog awaits it (mutateAsync); the source page leaves.
export function useDeleteKnowledgeSource(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.ApiResponse>(
        `/dashboard/knowledge-sources/${encodeURIComponent(publicId)}`,
        getToken,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: KnowledgeQueries.keys.source(publicId) });
      queryClient.removeQueries({ queryKey: KnowledgeQueries.keys.documents(publicId) });
      applySourceWrite(queryClient, undefined);
      toast.success("Source deleted.");
    },
    onError: (error) =>
      toast.error(
        sourceFailureText(error, "The source wasn't deleted. Nothing changed, try again."),
      ),
  });
}

// DEV_NOTE: One file into an upload source (named per call: Add source uploads into the source it just created).
// Callers await it (mutateAsync): Add a document answers the group with the new document; the upload buttons send
// files one after another.
export function useUploadKnowledgeDocument() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sourcePublicId: string; file: File }) => {
      const form = new FormData();
      form.append("file", params.file);
      return apiClient<Schemas.UploadKnowledgeDocumentApiResponse>(
        `/dashboard/knowledge-sources/${encodeURIComponent(params.sourcePublicId)}/documents`,
        getToken,
        { method: "POST", body: form },
      );
    },
    onSuccess: (_response, params) => {
      void queryClient.invalidateQueries({
        queryKey: KnowledgeQueries.keys.documents(params.sourcePublicId),
      });
      void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.sources() });
    },
    onError: (error, params) =>
      toast.error(
        `${params.file.name}: ${sourceFailureText(error, "it wasn't added. Try again.")}`,
      ),
  });
}

// DEV_NOTE: Remove an uploaded document. Its group (if it answered one) reopens, so the groups refetch too.
export function useDeleteKnowledgeDocument(sourcePublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentPublicId: string) =>
      apiClient<Schemas.DeleteKnowledgeDocumentApiResponse>(
        `/dashboard/knowledge-sources/${encodeURIComponent(sourcePublicId)}/documents/${encodeURIComponent(documentPublicId)}`,
        getToken,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: KnowledgeQueries.keys.documents(sourcePublicId),
      });
      void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.sources() });
      void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.clusters() });
      toast.success("Document removed.");
    },
    onError: (error) =>
      toast.error(
        sourceFailureText(error, "The document wasn't removed. Nothing changed, try again."),
      ),
  });
}

// DEV_NOTE: Why a group write was refused, in the dashboard's words (DESIGN.md §8)
function clusterFailureText(error: Error, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 409) return "This group was already closed. Nothing changed.";
  if (error.status === 404)
    return "That group or document isn't available any more. Nothing changed.";
  return fallback;
}

// DEV_NOTE: Answer a group with a document. The dialog awaits it (mutateAsync) and closes on success.
export function useAnswerDocGapCluster() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { clusterPublicId: string; documentPublicId: string }) =>
      apiClient<Schemas.UpdateDocGapClusterApiResponse>(
        `/dashboard/doc-gap-clusters/${encodeURIComponent(params.clusterPublicId)}/answer`,
        getToken,
        { method: "POST", body: JSON.stringify({ documentPublicId: params.documentPublicId }) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.clusters() });
      toast.success("Marked answered.");
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.clusters() });
      toast.error(
        clusterFailureText(error, "The group wasn't closed. Nothing changed, try again."),
      );
    },
  });
}

export function useDismissDocGapCluster() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clusterPublicId: string) =>
      apiClient<Schemas.UpdateDocGapClusterApiResponse>(
        `/dashboard/doc-gap-clusters/${encodeURIComponent(clusterPublicId)}/dismiss`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.clusters() });
      toast.success("Group dismissed.");
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: KnowledgeQueries.keys.clusters() });
      toast.error(
        clusterFailureText(error, "The group wasn't dismissed. Nothing changed, try again."),
      );
    },
  });
}

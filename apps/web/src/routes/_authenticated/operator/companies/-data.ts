import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import Utilities from "@/utils";
import {
  QUERY_KEY_ROOTS,
  invalidateOpenIssueViews,
  invalidateOperatorCompanyViews,
} from "../../-invalidation";

// DEV_NOTE: The operator's Companies pages (M7-8): the list per status tab + page, the tab counts, one company, and its
// connections. keys.all() covers them all. A status change sets the company's detail (setQueryData) and refetches the
// lists and counts; a new company refetches them too. A connection write sets that connection and refetches the
// company's list and the Companies list (its environments column).
export class OperatorCompaniesQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.operatorCompanies,
    lists: () => [...OperatorCompaniesQueries.keys.all(), "list"] as const,
    list: (search: Schemas.OperatorCompaniesPageSearch) =>
      [...OperatorCompaniesQueries.keys.lists(), search] as const,
    statusCounts: () => [...OperatorCompaniesQueries.keys.all(), "status-counts"] as const,
    details: () => [...OperatorCompaniesQueries.keys.all(), "detail"] as const,
    detail: (publicId: string) => [...OperatorCompaniesQueries.keys.details(), publicId] as const,
    connections: (publicId: string) =>
      [...OperatorCompaniesQueries.keys.detail(publicId), "connections"] as const,
    connection: (publicId: string, connectionPublicId: string) =>
      [...OperatorCompaniesQueries.keys.connections(publicId), connectionPublicId] as const,
    evalLogin: (publicId: string, connectionPublicId: string) =>
      [
        ...OperatorCompaniesQueries.keys.connection(publicId, connectionPublicId),
        "eval-login",
      ] as const,
    tools: (publicId: string) =>
      [...OperatorCompaniesQueries.keys.detail(publicId), "tools"] as const,
    toolList: (
      publicId: string,
      status: Schemas.ToolDefinitionStatusIntEnum | null,
      page: number,
    ) => [...OperatorCompaniesQueries.keys.tools(publicId), "list", status, page] as const,
    toolCount: (publicId: string, status: Schemas.ToolDefinitionStatusIntEnum | null) =>
      [...OperatorCompaniesQueries.keys.tools(publicId), "count", status] as const,
    toolVersions: (publicId: string, name: string) =>
      [...OperatorCompaniesQueries.keys.tools(publicId), "versions", name] as const,
    tool: (publicId: string, toolPublicId: string) =>
      [...OperatorCompaniesQueries.keys.tools(publicId), "detail", toolPublicId] as const,
  };

  static list(
    search: Schemas.OperatorCompaniesPageSearch,
    getToken: Parameters<typeof apiClient>[1],
  ) {
    const params = new URLSearchParams();
    const status =
      Schemas.OPERATOR_COMPANY_STATUS_TAB_MAP[
        search.status ?? Schemas.OperatorCompanyStatusTabEnum.All
      ];
    if (status !== null) params.set("status", String(status));
    params.set("pageNo", String(search.page ?? 1));
    params.set("pageSize", String(Schemas.OPERATOR_COMPANIES_PAGE_SIZE));
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.list(search),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetCompaniesApiResponse>(
          `/operator/companies?${params.toString()}`,
          getToken,
          { signal },
        ),
      // DEV_NOTE: The rows stay on screen while the next page or tab loads
      placeholderData: keepPreviousData,
    });
  }

  static statusCounts(getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.statusCounts(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetCompanyStatusCountsApiResponse>(
          "/operator/companies/status-counts",
          getToken,
          { signal },
        ),
    });
  }

  static detail(publicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.detail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetCompanyApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }

  static toolList(
    publicId: string,
    status: Schemas.ToolDefinitionStatusIntEnum | null,
    page: number,
    getToken: Parameters<typeof apiClient>[1],
  ) {
    const params = new URLSearchParams();
    if (status !== null) params.set("status", String(status));
    params.set("pageNo", String(page));
    params.set("pageSize", String(Schemas.OPERATOR_TOOLS_PAGE_SIZE));
    params.set("sortColumn", Schemas.ToolDefinitionSortColumn.Name);
    params.set("sortDirection", Schemas.SortDirection.Asc);
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.toolList(publicId, status, page),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetToolDefinitionsApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}/tool-definitions?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }

  static toolCount(
    publicId: string,
    status: Schemas.ToolDefinitionStatusIntEnum | null,
    getToken: Parameters<typeof apiClient>[1],
  ) {
    const params = new URLSearchParams();
    if (status !== null) params.set("status", String(status));
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.toolCount(publicId, status),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetToolDefinitionsCountApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}/tool-definitions/count?${params.toString()}`,
          getToken,
          { signal },
        ),
    });
  }

  static toolVersions(publicId: string, name: string, getToken: Parameters<typeof apiClient>[1]) {
    const params = new URLSearchParams({
      name,
      pageNo: "1",
      pageSize: String(Schemas.OPERATOR_TOOL_VERSIONS_PAGE_SIZE),
      sortColumn: Schemas.ToolDefinitionSortColumn.CreatedAt,
      sortDirection: Schemas.SortDirection.Desc,
    });
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.toolVersions(publicId, name),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetToolDefinitionsApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}/tool-definitions?${params.toString()}`,
          getToken,
          { signal },
        ),
    });
  }

  static tool(publicId: string, toolPublicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.tool(publicId, toolPublicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetToolDefinitionApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}/tool-definitions/${encodeURIComponent(toolPublicId)}`,
          getToken,
          { signal },
        ),
    });
  }

  static connections(publicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.connections(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetCompanyConnectionsApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}/connections`,
          getToken,
          { signal },
        ),
    });
  }

  static connection(
    publicId: string,
    connectionPublicId: string,
    getToken: Parameters<typeof apiClient>[1],
  ) {
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.connection(publicId, connectionPublicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetCompanyConnectionApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}/connections/${encodeURIComponent(connectionPublicId)}`,
          getToken,
          { signal },
        ),
    });
  }

  // DEV_NOTE: M7-9. A staging connection's test sign-in: kind and host user only (never a password or secret)
  static evalLogin(
    publicId: string,
    connectionPublicId: string,
    getToken: Parameters<typeof apiClient>[1],
  ) {
    return queryOptions({
      queryKey: OperatorCompaniesQueries.keys.evalLogin(publicId, connectionPublicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetEvalHostLoginApiResponse>(
          `/operator/companies/${encodeURIComponent(publicId)}/connections/${encodeURIComponent(connectionPublicId)}/eval-login`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useOperatorCompanies(search: Schemas.OperatorCompaniesPageSearch) {
  const { getToken } = useAuth();
  return useQuery(OperatorCompaniesQueries.list(search, getToken));
}

export function useCompanyStatusCounts() {
  const { getToken } = useAuth();
  return useQuery(OperatorCompaniesQueries.statusCounts(getToken));
}

// DEV_NOTE: enabled = false on a page that isn't a company's (the shell's breadcrumb asks on every operator page)
export function useOperatorCompany(publicId: string | null) {
  const { getToken } = useAuth();
  return useQuery({
    ...OperatorCompaniesQueries.detail(publicId ?? "", getToken),
    enabled: publicId !== null,
  });
}

// DEV_NOTE: New company. The caller awaits it (mutateAsync) to open the new company's page.
export function useCreateCompany() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.CreateCompanyApiRequest) =>
      apiClient<Schemas.CreateCompanyApiResponse>("/operator/companies", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      invalidateOperatorCompanyViews(queryClient);
      toast.success("Company created.");
    },
    onError: () => {
      toast.error("The company wasn't created. Nothing changed, try again.");
    },
  });
}

// DEV_NOTE: Pause, churn or reactivate. The caller awaits it (mutateAsync) to close its confirm dialog.
export function useSetCompanyStatus(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateCompanyStatusApiRequest) =>
      apiClient<Schemas.UpdateCompanyStatusApiResponse>(
        `/operator/companies/${encodeURIComponent(publicId)}/status`,
        getToken,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      if (response.company) {
        queryClient.setQueryData<Schemas.GetCompanyApiResponse>(
          OperatorCompaniesQueries.keys.detail(publicId),
          (previous) => ({ ...previous, isSuccess: true, company: response.company }),
        );
      }
      invalidateOperatorCompanyViews(queryClient);
      toast.success(
        `${response.company?.name ?? "The company"} is now ${response.company?.companyStatusLabel.toLowerCase() ?? "updated"}.`,
      );
    },
    onError: () => {
      toast.error("The status didn't change. Try again.");
    },
  });
}

// DEV_NOTE: Rebuild insights for a range of days. Each day runs in its own transaction: a 500 that lists failedDays
// rebuilt the others, so it names the days to try again.
export function useRebuildInsights(publicId: string) {
  const { getToken } = useAuth();
  return useMutation({
    mutationFn: (body: Schemas.RebuildActivityRollupsApiRequest) =>
      apiClient<Schemas.RebuildActivityRollupsApiResponse>(
        `/operator/companies/${encodeURIComponent(publicId)}/rollups/rebuild`,
        getToken,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      toast.success(`Rebuilt ${Utilities.plural(response.rebuiltDays?.length ?? 0, "day")}.`);
    },
    onError: (error) => {
      const body: Schemas.RebuildActivityRollupsApiResponse =
        error instanceof ApiError ? error.body : { isSuccess: false };
      const failed = body.failedDays ?? [];
      if (failed.length === 0) {
        toast.error("Nothing was rebuilt. Try again.");
        return;
      }
      toast.warning(
        `Rebuilt ${Utilities.plural(body.rebuiltDays?.length ?? 0, "day")}. ${failed.map((day) => Utilities.formatDay(day)).join(", ")} didn't rebuild: try those days again.`,
      );
    },
  });
}

export function useCompanyConnections(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(OperatorCompaniesQueries.connections(publicId, getToken));
}

// DEV_NOTE: enabled = false on the Add connection page
export function useCompanyConnection(publicId: string, connectionPublicId: string | null) {
  const { getToken } = useAuth();
  return useQuery({
    ...OperatorCompaniesQueries.connection(publicId, connectionPublicId ?? "", getToken),
    enabled: connectionPublicId !== null,
  });
}

// DEV_NOTE: Why a connection write was refused (409 / 400), in the page's words. A 409 is shown on the issuer field too.
export const CONNECTION_FAILURE_TEXT: Record<Schemas.CompanyConnectionFailureEnum, string> = {
  [Schemas.CompanyConnectionFailureEnum.IssuerTaken]:
    "Another connection already uses this JWT issuer. Nothing was saved.",
  [Schemas.CompanyConnectionFailureEnum.Invalid]:
    "The sign-in settings or clean-up call don't fit this connection. Nothing was saved.",
};

export function connectionFailure(error: unknown): Schemas.CompanyConnectionFailureEnum | null {
  if (!(error instanceof ApiError)) return null;
  return (error.body as Schemas.CreateCompanyConnectionApiResponse).failure ?? null;
}

function toastConnectionError(error: unknown) {
  const failure = connectionFailure(error);
  toast.error(
    failure ? CONNECTION_FAILURE_TEXT[failure] : "The connection wasn't saved. Try again.",
  );
}

// DEV_NOTE: Add a connection. The caller awaits it (mutateAsync) to go back to the company's page, or to show a refusal
// on its field.
export function useCreateConnection(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.CreateCompanyConnectionApiRequest) =>
      apiClient<Schemas.CreateCompanyConnectionApiResponse>(
        `/operator/companies/${encodeURIComponent(publicId)}/connections`,
        getToken,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      invalidateOperatorCompanyViews(queryClient);
      toast.success("Connection added.");
    },
    onError: toastConnectionError,
  });
}

export function useUpdateConnection(publicId: string, connectionPublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateCompanyConnectionApiRequest) =>
      apiClient<Schemas.UpdateCompanyConnectionApiResponse>(
        `/operator/companies/${encodeURIComponent(publicId)}/connections/${encodeURIComponent(connectionPublicId)}`,
        getToken,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      if (response.companyConnection) {
        queryClient.setQueryData<Schemas.GetCompanyConnectionApiResponse>(
          OperatorCompaniesQueries.keys.connection(publicId, connectionPublicId),
          (previous) => ({
            ...previous,
            isSuccess: true,
            companyConnection: response.companyConnection,
          }),
        );
      }
      invalidateOperatorCompanyViews(queryClient);
      toast.success("Connection saved.");
    },
    onError: toastConnectionError,
  });
}

// ─── Tool contract sync (ADR 0009)

// DEV_NOTE: What a refused or failed sync answered (a spec that can't be fetched is a 502 with the reason)
export function contractSyncResponse(error: unknown): Schemas.SyncToolContractApiResponse | null {
  return error instanceof ApiError ? (error.body as Schemas.SyncToolContractApiResponse) : null;
}

// DEV_NOTE: Reads the connection's spec and, unless isDryRun, writes what changed: new Active tool versions, Draft pins
// and a Tool update issue. The caller shows the answer in a dialog (the mutation's data, or its error's body).
export function useSyncToolContract(publicId: string, connectionPublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.SyncToolContractApiRequest) =>
      apiClient<Schemas.SyncToolContractApiResponse>(
        `/operator/companies/${encodeURIComponent(publicId)}/connections/${encodeURIComponent(connectionPublicId)}/contract-sync`,
        getToken,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: (response, body) => {
      if (body.isDryRun) return;
      // The connection shows when it was synced; tools and bot drafts changed; an issue may have opened
      void queryClient.invalidateQueries({
        queryKey: OperatorCompaniesQueries.keys.connections(publicId),
      });
      void queryClient.invalidateQueries({
        queryKey: OperatorCompaniesQueries.keys.tools(publicId),
      });
      invalidateOpenIssueViews(queryClient);
      toast.success(
        response.changes?.length ? "Tools updated from the spec." : "Every tool already matches.",
      );
    },
    onError: (error) => {
      const failure = contractSyncResponse(error)?.failure;
      toast.error(
        failure
          ? `${Schemas.TOOL_CONTRACT_SYNC_FAILURE_LABEL_MAP[failure]}.`
          : "The spec wasn't read. Try again.",
      );
    },
  });
}

// ─── Test sign-in for the hosted eval runner (M7-9)

export function useEvalHostLogin(publicId: string, connectionPublicId: string) {
  const { getToken } = useAuth();
  return useQuery(OperatorCompaniesQueries.evalLogin(publicId, connectionPublicId, getToken));
}

// DEV_NOTE: Set or replace a staging connection's test sign-in (the whole login: the password is never read back). The
// form awaits it (mutateAsync) to clear its secret fields.
export function useSetEvalHostLogin(publicId: string, connectionPublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.SetEvalHostLoginApiRequest) =>
      apiClient<Schemas.GetEvalHostLoginApiResponse>(
        `/operator/companies/${encodeURIComponent(publicId)}/connections/${encodeURIComponent(connectionPublicId)}/eval-login`,
        getToken,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      queryClient.setQueryData<Schemas.GetEvalHostLoginApiResponse>(
        OperatorCompaniesQueries.keys.evalLogin(publicId, connectionPublicId),
        {
          isSuccess: true,
          message: response.message,
          evalHostLogin: response.evalHostLogin ?? null,
        },
      );
      toast.success("Test sign-in saved.");
    },
    onError: (error) => {
      toast.error(
        connectionFailure(error) === Schemas.CompanyConnectionFailureEnum.Invalid
          ? "Only a staging connection takes a test sign-in. Nothing was saved."
          : "The test sign-in wasn't saved. Try again.",
      );
    },
  });
}

export function useRemoveEvalHostLogin(publicId: string, connectionPublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.GetEvalHostLoginApiResponse>(
        `/operator/companies/${encodeURIComponent(publicId)}/connections/${encodeURIComponent(connectionPublicId)}/eval-login`,
        getToken,
        { method: "DELETE" },
      ),
    onSuccess: (response) => {
      queryClient.setQueryData<Schemas.GetEvalHostLoginApiResponse>(
        OperatorCompaniesQueries.keys.evalLogin(publicId, connectionPublicId),
        { isSuccess: true, message: response.message, evalHostLogin: null },
      );
      toast.success("Test sign-in removed.");
    },
    onError: () => toast.error("The test sign-in wasn't removed. Try again."),
  });
}

// ─── Tools

export function useCompanyTools(
  publicId: string,
  status: Schemas.ToolDefinitionStatusIntEnum | null,
  page: number,
) {
  const { getToken } = useAuth();
  return useQuery(OperatorCompaniesQueries.toolList(publicId, status, page, getToken));
}

export function useCompanyToolCount(
  publicId: string,
  status: Schemas.ToolDefinitionStatusIntEnum | null,
) {
  const { getToken } = useAuth();
  return useQuery(OperatorCompaniesQueries.toolCount(publicId, status, getToken));
}

export function useToolVersions(publicId: string, name: string) {
  const { getToken } = useAuth();
  return useQuery(OperatorCompaniesQueries.toolVersions(publicId, name, getToken));
}

// DEV_NOTE: enabled = false on the New tool page
export function useCompanyTool(publicId: string, toolPublicId: string | null) {
  const { getToken } = useAuth();
  return useQuery({
    ...OperatorCompaniesQueries.tool(publicId, toolPublicId ?? "", getToken),
    enabled: toolPublicId !== null,
  });
}

// DEV_NOTE: Why a tool write was refused (409 / 400), in the page's words
const TOOL_FAILURE_TEXT: Record<Schemas.ToolDefinitionFailureEnum, string> = {
  [Schemas.ToolDefinitionFailureEnum.NotDraft]:
    "Only a draft can be changed. Start a new version instead. Nothing was saved.",
  [Schemas.ToolDefinitionFailureEnum.DraftExists]:
    "This tool already has a draft. Open it from Versions.",
  [Schemas.ToolDefinitionFailureEnum.NameTaken]:
    "A tool with this name exists. Start a new version of it instead.",
  [Schemas.ToolDefinitionFailureEnum.InvalidTransition]:
    "That status change isn't allowed from where this version is. Nothing changed.",
  [Schemas.ToolDefinitionFailureEnum.InvalidOps]:
    "The calls don't fit this tool's risk or input. Nothing was saved.",
  [Schemas.ToolDefinitionFailureEnum.ConnectionNotFound]:
    "That connection isn't one of this company's. Nothing was saved.",
  [Schemas.ToolDefinitionFailureEnum.ConnectionUnavailable]:
    "That connection is off or can't run tools. Nothing was saved.",
  [Schemas.ToolDefinitionFailureEnum.PinnedByPublishedConfig]:
    "A published bot version uses this tool version. Publish one without it first.",
};

function toastToolError(fallback: string) {
  return (error: unknown) => {
    const failure =
      error instanceof ApiError
        ? (error.body as Schemas.ToolDefinitionStateResponse).failure
        : undefined;
    toast.error(failure ? TOOL_FAILURE_TEXT[failure] : fallback);
  };
}

function toolsPath(publicId: string, toolPublicId?: string) {
  const base = `/operator/companies/${encodeURIComponent(publicId)}/tool-definitions`;
  return toolPublicId ? `${base}/${encodeURIComponent(toolPublicId)}` : base;
}

// DEV_NOTE: Every tool write answers with the version as it now is: set it, and refetch the company's tool lists,
// counts, versions and details
function useToolWriteSuccess(publicId: string) {
  const queryClient = useQueryClient();
  return (response: Schemas.ToolDefinitionMutationResponse) => {
    if (response.toolDefinition) {
      queryClient.setQueryData<Schemas.GetToolDefinitionApiResponse>(
        OperatorCompaniesQueries.keys.tool(publicId, response.toolDefinition.publicId),
        { isSuccess: true, toolDefinition: response.toolDefinition },
      );
    }
    void queryClient.invalidateQueries({ queryKey: OperatorCompaniesQueries.keys.tools(publicId) });
  };
}

// DEV_NOTE: The callers await these (mutateAsync) to open the version the write made or left
export function useCreateTool(publicId: string) {
  const { getToken } = useAuth();
  const onWrite = useToolWriteSuccess(publicId);
  return useMutation({
    mutationFn: (body: Schemas.CreateToolDefinitionApiRequest) =>
      apiClient<Schemas.CreateToolDefinitionApiResponse>(toolsPath(publicId), getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      onWrite(response);
      toast.success("Tool created as a draft.");
    },
    onError: toastToolError("The tool wasn't created. Nothing changed, try again."),
  });
}

export function useUpdateTool(publicId: string, toolPublicId: string) {
  const { getToken } = useAuth();
  const onWrite = useToolWriteSuccess(publicId);
  return useMutation({
    mutationFn: (body: Schemas.UpdateToolDefinitionApiRequest) =>
      apiClient<Schemas.UpdateToolDefinitionApiResponse>(
        toolsPath(publicId, toolPublicId),
        getToken,
        { method: "PATCH", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      onWrite(response);
      toast.success("Draft saved.");
    },
    onError: toastToolError("The draft wasn't saved. Try again."),
  });
}

export function useSetToolStatus(publicId: string, toolPublicId: string) {
  const { getToken } = useAuth();
  const onWrite = useToolWriteSuccess(publicId);
  return useMutation({
    mutationFn: (body: Schemas.SetToolDefinitionStatusApiRequest) =>
      apiClient<Schemas.SetToolDefinitionStatusApiResponse>(
        `${toolsPath(publicId, toolPublicId)}/status`,
        getToken,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      onWrite(response);
      toast.success(
        response.toolDefinition?.toolDefinitionStatus === Schemas.ToolDefinitionStatusIntEnum.Active
          ? "Version is active. Bot versions can now pin it."
          : "Version disabled.",
      );
    },
    onError: toastToolError("The status didn't change. Try again."),
  });
}

export function useCreateToolVersion(publicId: string, toolPublicId: string) {
  const { getToken } = useAuth();
  const onWrite = useToolWriteSuccess(publicId);
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.CreateToolDefinitionVersionApiResponse>(
        `${toolsPath(publicId, toolPublicId)}/versions`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response) => {
      onWrite(response);
      toast.success("New draft version started.");
    },
    onError: toastToolError("The new version wasn't started. Try again."),
  });
}

export function useDeleteTool(publicId: string, toolPublicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const onWrite = useToolWriteSuccess(publicId);
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.DeleteToolDefinitionApiResponse>(
        toolsPath(publicId, toolPublicId),
        getToken,
        {
          method: "DELETE",
        },
      ),
    onSuccess: (response) => {
      queryClient.removeQueries({
        queryKey: OperatorCompaniesQueries.keys.tool(publicId, toolPublicId),
      });
      onWrite(response);
      toast.success("Draft deleted.");
    },
    onError: toastToolError("The draft wasn't deleted. Try again."),
  });
}

// DEV_NOTE: M7-8. Loads a whole tool set onto a connection; the caller awaits it (mutateAsync) to show what changed and
// the pins. A draft refusal names its tools, so its toast is the server's message.
export function useLoadToolSet(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const fallback = toastToolError("The tools weren't loaded. Nothing changed, try again.");
  return useMutation({
    mutationFn: (body: Schemas.LoadToolSetApiRequest) =>
      apiClient<Schemas.LoadToolSetApiResponse>(`${toolsPath(publicId)}/tool-sets`, getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: OperatorCompaniesQueries.keys.tools(publicId),
      });
    },
    onError: (error) => {
      const body =
        error instanceof ApiError ? (error.body as Schemas.LoadToolSetApiResponse) : undefined;
      if (body?.failure === Schemas.ToolDefinitionFailureEnum.DraftExists && body.message) {
        toast.error(body.message);
        return;
      }
      fallback(error);
    },
  });
}

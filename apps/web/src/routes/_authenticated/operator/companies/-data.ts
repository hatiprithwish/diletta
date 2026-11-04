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
import { QUERY_KEY_ROOTS, invalidateOperatorCompanyViews } from "../../-invalidation";

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

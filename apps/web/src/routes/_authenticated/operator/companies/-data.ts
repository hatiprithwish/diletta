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

// DEV_NOTE: The operator's Companies pages (M7-8): the list per status tab + page, the tab counts, and one company.
// keys.all() covers them all. A status change sets the company's detail (setQueryData) and refetches the lists and
// counts; a new company refetches them too.
export class OperatorCompaniesQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.operatorCompanies,
    lists: () => [...OperatorCompaniesQueries.keys.all(), "list"] as const,
    list: (search: Schemas.OperatorCompaniesPageSearch) =>
      [...OperatorCompaniesQueries.keys.lists(), search] as const,
    statusCounts: () => [...OperatorCompaniesQueries.keys.all(), "status-counts"] as const,
    details: () => [...OperatorCompaniesQueries.keys.all(), "detail"] as const,
    detail: (publicId: string) => [...OperatorCompaniesQueries.keys.details(), publicId] as const,
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

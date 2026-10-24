import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";

// DEV_NOTE: The Impact page (M4-3): time saved from the hourly activity rollups and the minutes per task the company
// set. One query per range; keys.all() covers every range, so a saved minute value refreshes them all (hours saved
// are derived server-side, so there is no detail to patch with setQueryData).
export class ImpactQueries {
  static keys = {
    all: () => ["insights", "impact"] as const,
    detail: (range: Schemas.ImpactRangeEnum) => [...ImpactQueries.keys.all(), range] as const,
  };

  static detail(range: Schemas.ImpactRangeEnum, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: ImpactQueries.keys.detail(range),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetInsightsImpactApiResponse>(
          `/dashboard/insights/impact?range=${range}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useImpact(range: Schemas.ImpactRangeEnum) {
  const { getToken } = useAuth();
  return useQuery(ImpactQueries.detail(range, getToken));
}

// DEV_NOTE: A task's new minutes, in force from today. The dialog awaits it (mutateAsync) to close on success.
export function useCreateRoiAssumption() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.CreateRoiAssumptionApiRequest) =>
      apiClient<Schemas.CreateRoiAssumptionApiResponse>("/dashboard/roi-assumptions", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ImpactQueries.keys.all() }),
    onError: () => {
      toast.error("The time wasn't saved. Nothing changed, try again.");
    },
  });
}

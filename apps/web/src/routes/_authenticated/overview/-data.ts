import { queryOptions, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";

// DEV_NOTE: The Overview page's numbers (M4-3), from the hourly activity rollups plus what needs attention now. One
// query per range; keys.all() covers every range.
export class OverviewQueries {
  static keys = {
    all: () => ["insights", "overview"] as const,
    detail: (range: Schemas.InsightsRangeEnum) => [...OverviewQueries.keys.all(), range] as const,
  };

  static detail(range: Schemas.InsightsRangeEnum, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: OverviewQueries.keys.detail(range),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetInsightsOverviewApiResponse>(
          `/dashboard/insights/overview?range=${range}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useOverview(range: Schemas.InsightsRangeEnum) {
  const { getToken } = useAuth();
  return useQuery(OverviewQueries.detail(range, getToken));
}

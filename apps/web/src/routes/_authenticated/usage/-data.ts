import { queryOptions, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";

// DEV_NOTE: The Usage page's numbers (M4-3), from the hourly activity rollups. One query per range; keys.all() covers
// every range.
export class UsageQueries {
  static keys = {
    all: () => ["insights", "usage"] as const,
    detail: (range: Schemas.InsightsRangeEnum) => [...UsageQueries.keys.all(), range] as const,
  };

  static detail(range: Schemas.InsightsRangeEnum, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: UsageQueries.keys.detail(range),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetInsightsUsageApiResponse>(
          `/dashboard/insights/usage?range=${range}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useUsage(range: Schemas.InsightsRangeEnum) {
  const { getToken } = useAuth();
  return useQuery(UsageQueries.detail(range, getToken));
}

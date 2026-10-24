import { queryOptions, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";

// DEV_NOTE: Changes (M4-4: one change's detail, opened from a conversation; M4-5 adds the list, timeline and resolve).
// keys.all() covers every change.
export class ChangesQueries {
  static keys = {
    all: () => ["changes"] as const,
    details: () => [...ChangesQueries.keys.all(), "detail"] as const,
    detail: (publicId: string) => [...ChangesQueries.keys.details(), publicId] as const,
  };

  static detail(publicId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: ChangesQueries.keys.detail(publicId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetChangeRequestApiResponse>(
          `/dashboard/change-requests/${encodeURIComponent(publicId)}`,
          getToken,
          { signal },
        ),
    });
  }
}

export function useChange(publicId: string) {
  const { getToken } = useAuth();
  return useQuery(ChangesQueries.detail(publicId, getToken));
}

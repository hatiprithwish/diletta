import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";
import { QUERY_KEY_ROOTS } from "./-invalidation";

// DEV_NOTE: The signed-in admin. /dashboard/me also creates the admin on first sign-in from the Clerk invite, so
// the shell reads it before rendering any page. A 403 (no admins row, a churned company) throws an ApiError the
// shell turns into the No access screen; queryClient never retries a 4xx. The key carries the Clerk user, so a
// sign-out and sign-in as someone else (same tab, same QueryClient) never serves the previous admin and always
// calls /dashboard/me for the new one.
export class MeQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.me,
    detail: (clerkUserId: string) => [...MeQueries.keys.all(), "detail", clerkUserId] as const,
  };

  static detail(clerkUserId: string, getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: MeQueries.keys.detail(clerkUserId),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetMeApiResponse>("/dashboard/me", getToken, { signal }),
    });
  }
}

export function useMe() {
  const { userId, getToken } = useAuth();
  return useQuery({ ...MeQueries.detail(userId ?? "", getToken), enabled: Boolean(userId) });
}

// DEV_NOTE: ADR 0006. An operator starts acting in a company (the acting-company header already names it): the
// backend records their entry in the company's audit log. Nothing to cache.
export function useRecordOperatorActing() {
  const { getToken } = useAuth();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.RecordOperatorActedApiResponse>("/dashboard/acting", getToken, {
        method: "POST",
      }),
    onError: () => {
      toast.error("Your visit to this company wasn't recorded. Reload the page to try again.");
    },
  });
}

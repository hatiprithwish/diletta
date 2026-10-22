import { queryOptions, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";

// DEV_NOTE: The signed-in admin. /dashboard/me also creates the admin on first sign-in from the Clerk invite, so
// the shell reads it before rendering any page. A 403 (no admins row, a churned company) throws an ApiError the
// shell turns into the No access screen; queryClient never retries a 4xx.
export class MeQueries {
  static keys = {
    all: () => ["me"] as const,
    detail: () => [...MeQueries.keys.all(), "detail"] as const,
  };

  static detail(getToken: Parameters<typeof apiClient>[1]) {
    return queryOptions({
      queryKey: MeQueries.keys.detail(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetMeApiResponse>("/dashboard/me", getToken, { signal }),
    });
  }
}

export function useMe() {
  const { isSignedIn, getToken } = useAuth();
  return useQuery({ ...MeQueries.detail(getToken), enabled: isSignedIn === true });
}

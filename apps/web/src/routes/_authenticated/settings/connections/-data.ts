import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import type * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import { QUERY_KEY_ROOTS, SECURITY_KEY_SEGMENTS } from "../../-invalidation";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: Settings › Connections (M4-10): the company's connections. Origins are saved through the Security route
// (one write path); the answer updates this list (setQueryData) and the Security page's list refetches.
export class ConnectionsQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.connections,
    list: () => [...ConnectionsQueries.keys.all(), "list"] as const,
  };

  static list(getToken: GetToken) {
    return queryOptions({
      queryKey: ConnectionsQueries.keys.list(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetSettingsConnectionsApiResponse>(
          "/dashboard/settings/connections",
          getToken,
          { signal },
        ),
    });
  }
}

export function useConnections() {
  const { getToken } = useAuth();
  return useQuery(ConnectionsQueries.list(getToken));
}

// DEV_NOTE: Awaited by the origins dialog (mutateAsync), which closes on success
export function useUpdateConnectionOrigins(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateAllowedOriginsApiRequest) =>
      apiClient<Schemas.UpdateAllowedOriginsApiResponse>(
        `/dashboard/security/connections/${encodeURIComponent(publicId)}/origins`,
        getToken,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: ({ connection }) => {
      if (connection) {
        queryClient.setQueryData<Schemas.GetSettingsConnectionsApiResponse>(
          ConnectionsQueries.keys.list(),
          (current) =>
            current && {
              ...current,
              connections: current.connections?.map((row) =>
                row.publicId === connection.publicId ? { ...row, ...connection } : row,
              ),
            },
        );
      }
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY_ROOTS.security, SECURITY_KEY_SEGMENTS.connections],
      });
      toast.success("Allowed origins saved.");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: ConnectionsQueries.keys.all() });
        toast.error("This connection isn't available any more. Nothing changed.");
        return;
      }
      toast.error("The origins weren't saved. Nothing changed, try again.");
    },
  });
}

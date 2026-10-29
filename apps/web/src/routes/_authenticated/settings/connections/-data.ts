import { queryOptions, useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import type * as Schemas from "@app/schemas";
import { apiClient } from "@/providers/apiClient";
import { CONNECTIONS_LIST_SEGMENT, QUERY_KEY_ROOTS } from "../../-invalidation";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: Settings › Connections (M4-10): the company's connections. Origins are saved by the shared
// useUpdateAllowedOrigins (_authenticated/-originsMutation.ts), which refreshes this list and the Security page's.
export class ConnectionsQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.connections,
    list: () => [...ConnectionsQueries.keys.all(), CONNECTIONS_LIST_SEGMENT] as const,
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

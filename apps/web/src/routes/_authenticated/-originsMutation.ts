import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import type * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import { CONNECTIONS_LIST_SEGMENT, QUERY_KEY_ROOTS, SECURITY_KEY_SEGMENTS } from "./-invalidation";

// DEV_NOTE: The one client for the one origins write path (PUT /dashboard/security/connections/:publicId/origins), used
// by the Security page and Settings › Connections (M4-10) through components/origins-dialog's onSave. The saved row
// goes into both pages' connection lists and the audit log refetches; the dialog awaits it (mutateAsync) and closes on success.
export function useUpdateAllowedOrigins(publicId: string) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const refreshConnectionViews = () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.connections });
    void queryClient.invalidateQueries({
      queryKey: [...QUERY_KEY_ROOTS.security, SECURITY_KEY_SEGMENTS.connections],
    });
  };
  return useMutation({
    mutationFn: (body: Schemas.UpdateAllowedOriginsApiRequest) =>
      apiClient<Schemas.UpdateAllowedOriginsApiResponse>(
        `/dashboard/security/connections/${encodeURIComponent(publicId)}/origins`,
        getToken,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: ({ connection }) => {
      if (connection) {
        // DEV_NOTE: The answer is the saved row: both lists show it at once (Settings keeps its address and sign-in)
        queryClient.setQueryData<Schemas.GetSecurityConnectionsApiResponse>(
          [...QUERY_KEY_ROOTS.security, SECURITY_KEY_SEGMENTS.connections],
          (current) =>
            current && {
              ...current,
              connections: current.connections?.map((row) =>
                row.publicId === connection.publicId ? connection : row,
              ),
            },
        );
        queryClient.setQueryData<Schemas.GetSettingsConnectionsApiResponse>(
          [...QUERY_KEY_ROOTS.connections, CONNECTIONS_LIST_SEGMENT],
          (current) =>
            current && {
              ...current,
              connections: current.connections?.map((row) =>
                row.publicId === connection.publicId ? { ...row, ...connection } : row,
              ),
            },
        );
      } else {
        refreshConnectionViews();
      }
      void queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY_ROOTS.security, SECURITY_KEY_SEGMENTS.auditLog],
      });
      toast.success("Allowed origins saved.");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        refreshConnectionViews();
        toast.error("This connection isn't available any more. Nothing changed.");
        return;
      }
      toast.error("The origins weren't saved. Nothing changed, try again.");
    },
  });
}

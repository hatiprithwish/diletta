import {
  keepPreviousData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";
import Utilities from "@/utils";
import { QUERY_KEY_ROOTS, SECURITY_KEY_SEGMENTS } from "../-invalidation";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: Rows other pages add (audit rows, injection events): refetched on every visit, never served stale
const LIVE_LIST_STALE_TIME_MS = 0;

// DEV_NOTE: The Security page (M4-9): identity and origins, encryption keys, retention, prompt-injection events and the
// audit log. keys.all() covers them all. Every write here adds an audit row, so it refreshes the audit log too. Every
// other page's writes add audit rows as well, and a Quality triage can add an injection event, so those two lists (and
// their counts) are never fresh from the cache: staleTime 0 refetches them each time the page opens.
export class SecurityQueries {
  static keys = {
    all: () => QUERY_KEY_ROOTS.security,
    connections: () => [...SecurityQueries.keys.all(), SECURITY_KEY_SEGMENTS.connections] as const,
    encryptionKeys: () => [...SecurityQueries.keys.all(), "encryption-keys"] as const,
    retention: () => [...SecurityQueries.keys.all(), "retention"] as const,
    injectionEvents: () => [...SecurityQueries.keys.all(), "injection-events"] as const,
    injectionEventList: (page: number) =>
      [...SecurityQueries.keys.injectionEvents(), "list", page] as const,
    injectionEventCount: () => [...SecurityQueries.keys.injectionEvents(), "count"] as const,
    auditLog: () => [...SecurityQueries.keys.all(), "audit-log"] as const,
    auditLogList: (page: number) => [...SecurityQueries.keys.auditLog(), "list", page] as const,
    auditLogCount: () => [...SecurityQueries.keys.auditLog(), "count"] as const,
  };

  static connections(getToken: GetToken) {
    return queryOptions({
      queryKey: SecurityQueries.keys.connections(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetSecurityConnectionsApiResponse>(
          "/dashboard/security/connections",
          getToken,
          { signal },
        ),
    });
  }

  static encryptionKeys(getToken: GetToken) {
    return queryOptions({
      queryKey: SecurityQueries.keys.encryptionKeys(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetSecurityEncryptionKeysApiResponse>(
          "/dashboard/security/encryption-keys",
          getToken,
          { signal },
        ),
    });
  }

  static retention(getToken: GetToken) {
    return queryOptions({
      queryKey: SecurityQueries.keys.retention(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetContentRetentionApiResponse>(
          "/dashboard/security/retention",
          getToken,
          {
            signal,
          },
        ),
    });
  }

  static injectionEventList(page: number, getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(Schemas.INJECTION_EVENTS_PAGE_SIZE),
    });
    return queryOptions({
      queryKey: SecurityQueries.keys.injectionEventList(page),
      staleTime: LIVE_LIST_STALE_TIME_MS,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetInjectionEventsApiResponse>(
          `/dashboard/security/injection-events?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }

  static injectionEventCount(getToken: GetToken) {
    return queryOptions({
      queryKey: SecurityQueries.keys.injectionEventCount(),
      staleTime: LIVE_LIST_STALE_TIME_MS,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetInjectionEventsCountApiResponse>(
          "/dashboard/security/injection-events/count",
          getToken,
          { signal },
        ),
    });
  }

  static auditLogList(page: number, getToken: GetToken) {
    const params = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(Schemas.AUDIT_LOG_PAGE_SIZE),
    });
    return queryOptions({
      queryKey: SecurityQueries.keys.auditLogList(page),
      staleTime: LIVE_LIST_STALE_TIME_MS,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetAuditLogApiResponse>(
          `/dashboard/audit-log?${params.toString()}`,
          getToken,
          { signal },
        ),
      placeholderData: keepPreviousData,
    });
  }

  static auditLogCount(getToken: GetToken) {
    return queryOptions({
      queryKey: SecurityQueries.keys.auditLogCount(),
      staleTime: LIVE_LIST_STALE_TIME_MS,
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetAuditLogCountApiResponse>("/dashboard/audit-log/count", getToken, {
          signal,
        }),
    });
  }
}

export function useSecurityConnections() {
  const { getToken } = useAuth();
  return useQuery(SecurityQueries.connections(getToken));
}

export function useEncryptionKeys() {
  const { getToken } = useAuth();
  return useQuery(SecurityQueries.encryptionKeys(getToken));
}

export function useContentRetention() {
  const { getToken } = useAuth();
  return useQuery(SecurityQueries.retention(getToken));
}

export function useInjectionEvents(page: number) {
  const { getToken } = useAuth();
  return useQuery(SecurityQueries.injectionEventList(page, getToken));
}

export function useInjectionEventsCount() {
  const { getToken } = useAuth();
  return useQuery(SecurityQueries.injectionEventCount(getToken));
}

export function useAuditLog(page: number) {
  const { getToken } = useAuth();
  return useQuery(SecurityQueries.auditLogList(page, getToken));
}

export function useAuditLogCount() {
  const { getToken } = useAuth();
  return useQuery(SecurityQueries.auditLogCount(getToken));
}

function refreshAuditLog(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: SecurityQueries.keys.auditLog() });
}

// DEV_NOTE: Replaces a connection's allowed origins; the list shows the answer at once. The dialog awaits it
// (mutateAsync) and closes on success.
export function useUpdateAllowedOrigins(publicId: string) {
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
        queryClient.setQueryData<Schemas.GetSecurityConnectionsApiResponse>(
          SecurityQueries.keys.connections(),
          (current) =>
            current && {
              ...current,
              connections: current.connections?.map((row) =>
                row.publicId === connection.publicId ? connection : row,
              ),
            },
        );
      }
      refreshAuditLog(queryClient);
      // DEV_NOTE: Settings › Connections shows the same origins
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY_ROOTS.connections });
      toast.success("Allowed origins saved.");
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: SecurityQueries.keys.connections() });
        toast.error("This connection isn't available any more. Nothing changed.");
        return;
      }
      toast.error("The origins weren't saved. Nothing changed, try again.");
    },
  });
}

// DEV_NOTE: Rotate key; the keys table shows the answer at once. A rotation still in progress (409) reloads the keys.
export function useRotateEncryptionKey() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient<Schemas.RotateEncryptionKeyApiResponse>(
        "/dashboard/security/encryption-keys/rotate",
        getToken,
        { method: "POST" },
      ),
    onSuccess: (response) => {
      if (response.encryptionKeys) {
        queryClient.setQueryData<Schemas.GetSecurityEncryptionKeysApiResponse>(
          SecurityQueries.keys.encryptionKeys(),
          {
            isSuccess: true,
            encryptionKeys: response.encryptionKeys,
            isRotationInProgress: response.isRotationInProgress,
          },
        );
      } else {
        void queryClient.invalidateQueries({ queryKey: SecurityQueries.keys.encryptionKeys() });
      }
      refreshAuditLog(queryClient);
      toast.success("Encryption key rotated. New data uses the new key.");
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: SecurityQueries.keys.encryptionKeys() });
      if (error instanceof ApiError && error.status === 409) {
        toast.error("A rotation is still in progress. Try again once the old key is retired.");
        return;
      }
      toast.error("The key wasn't rotated. Nothing changed, try again.");
    },
  });
}

export function useUpdateContentRetention() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.UpdateContentRetentionApiRequest) =>
      apiClient<Schemas.UpdateContentRetentionApiResponse>(
        "/dashboard/security/retention",
        getToken,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    onSuccess: (response) => {
      queryClient.setQueryData<Schemas.GetContentRetentionApiResponse>(
        SecurityQueries.keys.retention(),
        response,
      );
      refreshAuditLog(queryClient);
      toast.success("Retention saved.");
    },
    onError: () => {
      toast.error("Retention wasn't saved. Nothing changed, try again.");
    },
  });
}

const CSV_HEADER = ["Who", "Action", "On", "When"];

// DEV_NOTE: Downloads the newest AUDIT_LOG_EXPORT_MAX_ROWS rows as a CSV. It reads, but runs on a click, so it's a
// mutation.
export function useExportAuditLog() {
  const { getToken } = useAuth();
  return useMutation({
    mutationFn: async () => {
      const response = await apiClient<Schemas.ExportAuditLogApiResponse>(
        "/dashboard/audit-log/export",
        getToken,
      );
      const rows = (response.auditLog ?? []).map((entry) => [
        entry.actorName ?? entry.actorTypeLabel,
        entry.action,
        entry.on ?? "",
        entry.createdAt,
      ]);
      Utilities.downloadFile(
        `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
        // DEV_NOTE: The BOM makes Excel read the file as UTF-8 (names in any script); other apps ignore it
        `\uFEFF${Utilities.toCsv([CSV_HEADER, ...rows])}`,
        "text/csv;charset=utf-8",
      );
      return { count: rows.length, isTruncated: response.isTruncated ?? false };
    },
    onSuccess: ({ count, isTruncated }) => {
      toast.success(
        isTruncated
          ? `Exported the newest ${Utilities.formatCount(count)} rows.`
          : `Exported ${Utilities.plural(count, "row")}.`,
      );
    },
    onError: () => {
      toast.error("The export didn't download. Try again.");
    },
  });
}

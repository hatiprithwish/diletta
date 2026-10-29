import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { ApiError, apiClient } from "@/providers/apiClient";

type GetToken = Parameters<typeof apiClient>[1];

// DEV_NOTE: Settings › Team (M4-10): the company's admins and Pending invites in one read. Every write refetches it
// (an invite, revoke or removal changes which rows show).
export class TeamQueries {
  static keys = {
    all: () => ["team"] as const,
    team: () => [...TeamQueries.keys.all(), "team"] as const,
  };

  static team(getToken: GetToken) {
    return queryOptions({
      queryKey: TeamQueries.keys.team(),
      queryFn: ({ signal }) =>
        apiClient<Schemas.GetTeamApiResponse>("/dashboard/settings/team", getToken, { signal }),
    });
  }
}

export function useTeam() {
  const { getToken } = useAuth();
  return useQuery(TeamQueries.team(getToken));
}

// DEV_NOTE: Why a team write changed nothing, in the page's words (also shown inline by the invite dialog)
export const TEAM_REFUSAL_COPY: Record<Schemas.TeamFailureEnum, string> = {
  [Schemas.TeamFailureEnum.AlreadyAdmin]:
    "This person is already an admin, here or for another company.",
  [Schemas.TeamFailureEnum.AlreadyInvited]:
    "This email already has an invite. Revoke it to send a new one.",
  [Schemas.TeamFailureEnum.NotPending]: "This invite was already accepted or revoked.",
  [Schemas.TeamFailureEnum.CannotRemoveSelf]: "You can't remove yourself. Ask another admin.",
  [Schemas.TeamFailureEnum.LastAdmin]: "The last admin can't be removed.",
  [Schemas.TeamFailureEnum.ClerkUnavailable]:
    "The sign-in service couldn't be reached. Nothing changed, try again.",
};

export function teamRefusalOf(error: unknown): Schemas.TeamFailureEnum | null {
  if (!(error instanceof ApiError)) return null;
  return (error.body as Schemas.TeamWriteApiResponse).failure ?? null;
}

function toastTeamError(queryClient: QueryClient, error: unknown, fallback: string) {
  const refusal = teamRefusalOf(error);
  if (refusal) {
    void queryClient.invalidateQueries({ queryKey: TeamQueries.keys.all() });
    toast.error(TEAM_REFUSAL_COPY[refusal]);
    return;
  }
  if (error instanceof ApiError && error.status === 404) {
    void queryClient.invalidateQueries({ queryKey: TeamQueries.keys.all() });
    toast.error("This person isn't on the team any more. Nothing changed.");
    return;
  }
  toast.error(`${fallback} Nothing changed, try again.`);
}

// DEV_NOTE: Awaited by the invite dialog (mutateAsync), which closes on success and shows a refusal inline
export function useInviteAdmin() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas.CreateAdminInviteApiRequest) =>
      apiClient<Schemas.TeamWriteApiResponse>("/dashboard/settings/team/invites", getToken, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: TeamQueries.keys.all() });
      toast.success(
        response.invite?.isEmailed === false
          ? `${response.invite.email} already has an account: they get access at their next sign-in. No email was sent, so let them know.`
          : `Invite sent to ${response.invite?.email ?? "them"}.`,
      );
    },
    onError: (error) => toastTeamError(queryClient, error, "The invite wasn't sent."),
  });
}

export function useRevokeInvite() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (publicId: string) =>
      apiClient<Schemas.TeamWriteApiResponse>(
        `/dashboard/settings/team/invites/${encodeURIComponent(publicId)}/revoke`,
        getToken,
        { method: "POST" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TeamQueries.keys.all() });
      toast.success("Invite revoked. The link no longer works.");
    },
    onError: (error) => toastTeamError(queryClient, error, "The invite wasn't revoked."),
  });
}

export function useRemoveAdmin() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clerkUserId: string) =>
      apiClient<Schemas.TeamWriteApiResponse>(
        `/dashboard/settings/team/admins/${encodeURIComponent(clerkUserId)}`,
        getToken,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TeamQueries.keys.all() });
      toast.success("Admin removed. They lose access from their next page load.");
    },
    onError: (error) => toastTeamError(queryClient, error, "The admin wasn't removed."),
  });
}

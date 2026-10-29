import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { DotsThree, Plus } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@app/ui/components/alert-dialog";
import { Button } from "@app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@app/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@app/ui/components/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
import { Skeleton } from "@app/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@app/ui/components/table";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import {
  TEAM_REFUSAL_COPY,
  teamRefusalOf,
  useInviteAdmin,
  useRemoveAdmin,
  useRevokeInvite,
  useTeam,
} from "./-data";

// DEV_NOTE: The whole /settings/team body (DESIGN.md dashboard-Team): the company's admins, then its Pending invites, in
// one table. Everyone here is an admin (no roles).
export function TeamPage() {
  const query = useTeam();
  const [isInviting, setIsInviting] = useState(false);
  const team = query.data?.team;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Team" description="People who can use this dashboard" />
      <section className="flex flex-col gap-4" aria-label="Team">
        <SectionHeader
          title="Team"
          description="People who can use this dashboard. Everyone here is an admin."
        >
          <Button onClick={() => setIsInviting(true)}>
            <Plus aria-hidden />
            Invite
          </Button>
        </SectionHeader>
        {query.isPending && <Skeleton className="h-40 rounded-xl" aria-label="Loading" />}
        {!query.isPending && !team && (
          <PageError title="The team didn't load" onRetry={() => void query.refetch()} />
        )}
        {team && (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Name</TableHead>
                  <TableHead className="px-4">Email</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Last active</TableHead>
                  <TableHead className="w-12 px-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {team.members.map((member) => (
                  <MemberRow
                    key={member.clerkUserId}
                    member={member}
                    isLastActiveKnown={team.isLastActiveKnown}
                  />
                ))}
                {team.invites.map((invite) => (
                  <InviteRow key={invite.publicId} invite={invite} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {team && !team.isLastActiveKnown && (
          <p className="text-caption text-muted-foreground">
            Last active couldn't be read right now. Try again later.
          </p>
        )}
      </section>
      <InviteDialog isOpen={isInviting} onClose={() => setIsInviting(false)} />
    </div>
  );
}

function MemberRow({ member, isLastActiveKnown }: Schemas.DashboardTeamMemberRowProps) {
  const remove = useRemoveAdmin();
  const [isConfirming, setIsConfirming] = useState(false);
  const who = member.name ?? member.email ?? "This admin";

  return (
    <TableRow>
      <TableCell className="px-4 py-3 text-foreground">
        {member.name ?? <span className="text-muted-foreground">No name yet</span>}
        {member.isYou && <span className="text-muted-foreground"> (you)</span>}
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">{member.email ?? "—"}</TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip label="Admin" tone={Schemas.DashboardChipToneEnum.Success} />
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">
        {member.lastActiveAt
          ? Utilities.formatWhen(member.lastActiveAt)
          : isLastActiveKnown
            ? "Not yet"
            : "—"}
      </TableCell>
      <TableCell className="px-4 py-3">
        {!member.isYou && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-subtle-foreground"
                  aria-label={`Actions for ${who}`}
                >
                  <DotsThree />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() => setIsConfirming(true)}
                >
                  Remove from team
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {who}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    They lose access to this dashboard from their next page load. To add them back,
                    send a new invite.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(member.clerkUserId)}
                  >
                    Remove
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </TableCell>
    </TableRow>
  );
}

function InviteRow({ invite }: Schemas.DashboardTeamInviteRowProps) {
  const revoke = useRevokeInvite();
  const [isConfirming, setIsConfirming] = useState(false);

  return (
    <TableRow>
      <TableCell className="px-4 py-3 text-muted-foreground">
        {invite.isEmailed ? "Invite emailed" : "Access at next sign-in"}
      </TableCell>
      <TableCell className="px-4 py-3 text-foreground">{invite.email}</TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip label={invite.statusLabel} tone={Schemas.DashboardChipToneEnum.Warning} />
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">—</TableCell>
      <TableCell className="px-4 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-subtle-foreground"
              aria-label={`Actions for ${invite.email}`}
            >
              <DotsThree />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="text-destructive" onSelect={() => setIsConfirming(true)}>
              Revoke invite
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke the invite to {invite.email}?</AlertDialogTitle>
              <AlertDialogDescription>
                {invite.isEmailed
                  ? "The link in their email stops working."
                  : "They won't get access when they next sign in."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(invite.publicId)}
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function emailIssue(value: string): string | undefined {
  return Schemas.ZAdminInviteEmail.safeParse(value).success ? undefined : "Enter an email address.";
}

// DEV_NOTE: Invite by email. Awaits the write (mutateAsync): closes on success, shows a refusal inline otherwise.
function InviteDialog({ isOpen, onClose }: Schemas.DashboardInviteDialogProps) {
  const invite = useInviteAdmin();
  const [refusal, setRefusal] = useState<Schemas.TeamFailureEnum | null>(null);
  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      setRefusal(null);
      try {
        await invite.mutateAsync({ email: value.email });
      } catch (error) {
        setRefusal(teamRefusalOf(error));
        return;
      }
      close();
    },
  });
  function close() {
    form.reset();
    setRefusal(null);
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Invite an admin</DialogTitle>
            <DialogDescription>
              They can do everything you can on this dashboard, including inviting others.
            </DialogDescription>
          </DialogHeader>
          <form.Field name="email" validators={{ onChange: ({ value }) => emailIssue(value) }}>
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0 || refusal !== null}>
                <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                <Input
                  id="invite-email"
                  name={field.name}
                  type="email"
                  autoComplete="off"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    setRefusal(null);
                    field.handleChange(event.target.value);
                  }}
                  aria-invalid={field.state.meta.errors.length > 0 || refusal !== null}
                />
                <FieldDescription>
                  We email them a link. Someone who already has an account gets access at their next
                  sign-in instead.
                </FieldDescription>
                <FieldError
                  errors={
                    refusal
                      ? [{ message: TEAM_REFUSAL_COPY[refusal] }]
                      : Utilities.toFieldErrors(field.state.meta.errors)
                  }
                />
              </Field>
            )}
          </form.Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? "Sending…" : "Send invite"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

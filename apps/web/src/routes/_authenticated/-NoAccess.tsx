import { useClerk } from "@clerk/tanstack-react-start";
import { Button } from "@app/ui/components/button";
import { ShellMessage } from "./-ShellMessage";

// DEV_NOTE: Signed in to Clerk but no dashboard: not invited (no admins row), or the company has churned.
// /dashboard/me answers 403 for both. An operator gets the company picker instead (ADR 0006).
export function NoAccess() {
  const { signOut } = useClerk();

  return (
    <ShellMessage
      title="You don't have access to this dashboard"
      description="Ask your company admin for an invite, or sign in with another account."
    >
      <Button variant="outline" onClick={() => void signOut({ redirectUrl: "/auth/sign-in" })}>
        Sign out
      </Button>
    </ShellMessage>
  );
}

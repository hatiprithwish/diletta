import { useClerk } from "@clerk/tanstack-react-start";
import { Button } from "@app/ui/components/button";
import { ShellMessage } from "./-ShellMessage";

// DEV_NOTE: Signed in to Clerk but no dashboard: not invited (no admins row), the company has churned, or an
// operator (no company; the dashboard is company-level). /dashboard/me answers 403 for the first two.
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

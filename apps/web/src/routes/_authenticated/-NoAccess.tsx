import { useClerk } from "@clerk/tanstack-react-start";
import { Button } from "@app/ui/components/button";

// DEV_NOTE: Signed in to Clerk but no dashboard: not invited (no admins row), the company has churned, or an
// operator (no company; the dashboard is company-level). /dashboard/me answers 403 for the first two.
export function NoAccess() {
  const { signOut } = useClerk();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-section text-foreground">You don't have access to this dashboard</h1>
        <p className="text-body text-muted-foreground">
          Ask your company admin for an invite, or sign in with another account.
        </p>
      </div>
      <Button variant="outline" onClick={() => void signOut({ redirectUrl: "/auth/sign-in" })}>
        Sign out
      </Button>
    </div>
  );
}

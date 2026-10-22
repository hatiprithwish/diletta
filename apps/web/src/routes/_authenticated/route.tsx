import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@app/ui/components/button";
import { SidebarInset, SidebarProvider } from "@app/ui/components/sidebar";
import { Skeleton } from "@app/ui/components/skeleton";
import * as Schemas from "@app/schemas";
import { ApiError } from "@/providers/apiClient";
import Utilities from "@/utils";
import { useMe } from "./-data";
import { AppSidebar } from "./-AppSidebar";
import { TopBar } from "./-TopBar";
import { NoAccess } from "./-NoAccess";
import { ShellMessage } from "./-ShellMessage";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { isSignedIn, isLoaded } = useAuth();

  if (!isLoaded) return null;

  if (!isSignedIn) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <p className="text-lg text-muted-foreground">Please sign in to see this page.</p>
        <Button asChild>
          <Link to="/auth/sign-in">Sign in</Link>
        </Button>
      </div>
    );
  }

  return <DashboardShell />;
}

// DEV_NOTE: The cookie shadcn's SidebarProvider writes on every toggle (sidebar.tsx keeps the name private)
const SIDEBAR_STATE_COOKIE = "sidebar_state";

// DEV_NOTE: /dashboard/me runs before any page: it creates the admin on first sign-in from the Clerk invite, and
// every other dashboard route answers 403 until that admin exists. The shell renders only in the browser (Clerk
// isn't loaded during SSR), so the sidebar's saved state is read from document.cookie with no hydration mismatch.
function DashboardShell() {
  const me = useMe();
  const isSidebarOpen = Utilities.getCookie(SIDEBAR_STATE_COOKIE) !== "false";

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center" aria-busy="true">
        <Skeleton className="size-8 rounded-lg" />
      </div>
    );
  }

  // A 403 always ends the session's access (e.g. the company churned). Any other failure blocks only the first
  // load: a failed background refetch keeps the admin already loaded, so the page and its state stay mounted.
  if (me.isError && me.error instanceof ApiError && me.error.status === 403) return <NoAccess />;
  if (!me.data) {
    return (
      <ShellMessage
        title="The dashboard didn't load"
        description="Check your connection and try again."
      >
        <Button variant="outline" onClick={() => void me.refetch()}>
          Try again
        </Button>
      </ShellMessage>
    );
  }

  const admin = me.data.admin;
  if (!admin || admin.role !== Schemas.AdminRoleEnum.CompanyAdmin) return <NoAccess />;

  return (
    <SidebarProvider defaultOpen={isSidebarOpen}>
      <AppSidebar admin={admin} />
      <SidebarInset>
        <TopBar />
        <div className="mx-auto w-full max-w-[1180px] px-8 pt-9 pb-12">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

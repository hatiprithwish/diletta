import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@app/ui/components/button";
import { SidebarInset, SidebarProvider } from "@app/ui/components/sidebar";
import { Skeleton } from "@app/ui/components/skeleton";
import * as Schemas from "@app/schemas";
import { ApiError } from "@/providers/apiClient";
import { useMe } from "./-data";
import { AppSidebar } from "./-AppSidebar";
import { TopBar } from "./-TopBar";
import { NoAccess } from "./-NoAccess";

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

// DEV_NOTE: /dashboard/me runs before any page: it creates the admin on first sign-in from the Clerk invite, and
// every other dashboard route answers 403 until that admin exists.
function DashboardShell() {
  const me = useMe();

  if (me.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center" aria-busy="true">
        <Skeleton className="size-8 rounded-lg" />
      </div>
    );
  }

  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 403) return <NoAccess />;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="flex flex-col gap-1">
          <h1 className="text-section text-foreground">The dashboard didn't load</h1>
          <p className="text-body text-muted-foreground">Check your connection and try again.</p>
        </div>
        <Button variant="outline" onClick={() => void me.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const admin = me.data.admin;
  if (!admin || admin.role !== Schemas.AdminRoleEnum.CompanyAdmin) return <NoAccess />;

  return (
    <SidebarProvider>
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

import { useEffect } from "react";
import {
  createFileRoute,
  Outlet,
  Link,
  retainSearchParams,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { Button } from "@app/ui/components/button";
import { SidebarInset, SidebarProvider } from "@app/ui/components/sidebar";
import { Skeleton } from "@app/ui/components/skeleton";
import * as Schemas from "@app/schemas";
import { ApiError, setActingCompany } from "@/providers/apiClient";
import Utilities from "@/utils";
import { MeQueries, useMe, useRecordOperatorActing } from "./-data";
import { CompanyPicker } from "./-CompanyPicker";
import { AppSidebar } from "./-AppSidebar";
import { TopBar } from "./-TopBar";
import { NoAccess } from "./-NoAccess";
import { ShellMessage } from "./-ShellMessage";

// DEV_NOTE: ADR 0006. ?company= is the company a signed-in operator acts in, kept on every dashboard link
export const Route = createFileRoute("/_authenticated")({
  validateSearch: Schemas.ZActingCompanySearch,
  search: { middlewares: [retainSearchParams(["company"])] },
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const recordActing = useRecordOperatorActing();
  const { company } = Schemas.ZActingCompanySearch.parse(useSearch({ strict: false }));

  // DEV_NOTE: ADR 0006. An operator acts in the company ?company names (one they may act in, else the picker). The
  // header is set during render, so the pages' first requests already carry it; a company admin never sends one.
  const admin = me.data?.admin;
  const actingCompany =
    admin?.role === Schemas.AdminRoleEnum.Operator
      ? (admin.actingCompanies?.find((row) => row.publicId === company) ?? null)
      : null;
  setActingCompany(actingCompany?.publicId ?? null);

  // DEV_NOTE: One audit row per company an operator opens in this page load (a reload, or a link with ?company,
  // records again). recordActing is stable enough: only the company changes the effect.
  const actingPublicId = actingCompany?.publicId;
  const { mutate: recordEntry } = recordActing;
  useEffect(() => {
    if (actingPublicId) recordEntry();
  }, [actingPublicId, recordEntry]);

  // DEV_NOTE: Another company's data must never show: everything but the signed-in admin is dropped on a switch
  const actIn = (publicId: string | undefined) => {
    setActingCompany(publicId ?? null);
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] !== MeQueries.keys.all()[0],
    });
    void navigate({ to: ".", search: (prev) => ({ ...prev, company: publicId }) });
  };

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

  if (!admin) return <NoAccess />;
  if (admin.role === Schemas.AdminRoleEnum.Operator && !actingCompany) {
    return <CompanyPicker companies={admin.actingCompanies ?? []} onPick={actIn} />;
  }

  // DEV_NOTE: Keyed by the acting company, so switching remounts every page on the new company's data
  return (
    <SidebarProvider key={actingCompany?.publicId ?? "own"} defaultOpen={isSidebarOpen}>
      <AppSidebar
        admin={
          actingCompany
            ? { ...admin, company: { publicId: actingCompany.publicId, name: actingCompany.name } }
            : admin
        }
      />
      <SidebarInset>
        <TopBar
          actingCompanyName={actingCompany?.name ?? null}
          onSwitchCompany={() => actIn(undefined)}
        />
        <div className="mx-auto w-full max-w-[1180px] px-8 pt-9 pb-12">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

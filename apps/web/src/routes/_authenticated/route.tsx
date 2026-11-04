import { useEffect, useState } from "react";
import {
  createFileRoute,
  Outlet,
  Link,
  Navigate,
  retainSearchParams,
  useLocation,
  useNavigate,
  useParams,
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
import { useMe, useRecordOperatorActing } from "./-data";
import { QUERY_KEY_ROOTS } from "./-invalidation";
import { getBreadcrumbs, isOperatorPath } from "./-nav";
import { useOperatorCompany } from "./operator/companies/-data";
import { AppSidebar } from "./-AppSidebar";
import { OperatorSidebar } from "./-OperatorSidebar";
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

// DEV_NOTE: The query roots that aren't one company's data: they survive an operator moving between companies
const COMPANY_FREE_ROOTS: readonly string[] = [
  QUERY_KEY_ROOTS.me[0],
  QUERY_KEY_ROOTS.operatorCompanies[0],
];

// DEV_NOTE: /dashboard/me runs before any page: it creates the admin on first sign-in from the Clerk invite, and
// every other dashboard route answers 403 until that admin exists. The shell renders only in the browser (Clerk
// isn't loaded during SSR), so the sidebar's saved state is read from document.cookie with no hydration mismatch.
// M7-8: an operator gets the operator pages (/operator/*) in their own shell, and a company's dashboard only while
// acting in it (?company=); a company admin never sees the operator pages.
function DashboardShell() {
  const me = useMe();
  const isSidebarOpen = Utilities.getCookie(SIDEBAR_STATE_COOKIE) !== "false";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const recordActing = useRecordOperatorActing();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { company } = Schemas.ZActingCompanySearch.parse(useSearch({ strict: false }));
  const params: { id?: string } = useParams({ strict: false });
  const isOperatorPage = isOperatorPath(pathname);

  // DEV_NOTE: ADR 0006. An operator acts in the company ?company names (one they may act in) on a dashboard page;
  // never on an operator page. The header is set during render, so the pages' first requests already carry it; a
  // company admin never sends one.
  const admin = me.data?.admin;
  const isOperator = admin?.role === Schemas.AdminRoleEnum.Operator;
  const actingCompany =
    isOperator && !isOperatorPage
      ? (admin?.actingCompanies?.find((row) => row.publicId === company) ?? null)
      : null;
  const actingPublicId = actingCompany?.publicId ?? null;
  setActingCompany(actingPublicId);

  // DEV_NOTE: Another company's data must never show: when the company acted in changes (another company, or back to
  // the operator pages), everything one company owns is dropped before the pages render
  const [renderedActing, setRenderedActing] = useState(actingPublicId);
  if (renderedActing !== actingPublicId) {
    setRenderedActing(actingPublicId);
    queryClient.removeQueries({
      predicate: (query) => !COMPANY_FREE_ROOTS.includes(String(query.queryKey[0])),
    });
  }

  // DEV_NOTE: One audit row per company an operator opens in this page load (a reload, or a link with ?company,
  // records again). recordActing is stable enough: only the company changes the effect.
  const { mutate: recordEntry } = recordActing;
  useEffect(() => {
    if (actingPublicId) recordEntry();
  }, [actingPublicId, recordEntry]);

  // DEV_NOTE: An operator page about one company shows its name in the breadcrumb
  const operatorCompanyId =
    isOperator && isOperatorPage && params.id !== undefined ? params.id : null;
  const operatorCompany = useOperatorCompany(operatorCompanyId).data?.company;
  const crumbs = operatorCompany
    ? [...getBreadcrumbs(pathname), operatorCompany.name]
    : getBreadcrumbs(pathname);

  const backToOperator = () => {
    if (!actingCompany) return;
    void navigate({
      to: "/operator/companies/$id",
      params: { id: actingCompany.publicId },
      search: { company: undefined },
    });
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
  // DEV_NOTE: The operator pages are an operator's only; a company admin lands on their own dashboard
  if (!isOperator && isOperatorPage) return <Navigate to="/overview" />;
  // DEV_NOTE: An operator on a dashboard page with no company they may act in (none picked, unknown or churned)
  if (isOperator && !isOperatorPage && !actingCompany) {
    return <Navigate to="/operator/companies" search={{ company: undefined }} />;
  }

  // DEV_NOTE: Keyed by the company shown, so moving between companies (or back to the operator pages) remounts every
  // page on the new company's data
  return (
    <SidebarProvider key={actingPublicId ?? "own"} defaultOpen={isSidebarOpen}>
      {isOperatorPage ? (
        <OperatorSidebar admin={admin} />
      ) : (
        <AppSidebar
          admin={
            actingCompany
              ? {
                  ...admin,
                  company: { publicId: actingCompany.publicId, name: actingCompany.name },
                }
              : admin
          }
        />
      )}
      <SidebarInset>
        <TopBar crumbs={crumbs} actingCompany={actingCompany} onBackToOperator={backToOperator} />
        <div className="mx-auto w-full max-w-[1180px] px-8 pt-9 pb-12">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

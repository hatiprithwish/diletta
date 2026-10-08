import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { useEffect, useRef } from "react";
import { Button } from "@app/ui/components/button";
import { apiClient } from "@/providers/apiClient";
import type * as Schemas from "@app/schemas";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const meRequestedRef = useRef(false);

  // DEV_NOTE: /dashboard/me creates the admin on first sign-in from the Clerk invite, so it runs once per session
  // before any dashboard call. A 403 (not invited) is handled on the server; the "No access" screen comes with the
  // dashboard shell (M4-1), which reads /dashboard/me through its own query.
  useEffect(() => {
    if (!isSignedIn || meRequestedRef.current) return;
    meRequestedRef.current = true;
    apiClient<Schemas.GetMeApiResponse>("/dashboard/me", getToken).catch(() => {
      // Non-fatal here — the server logs failures, and every dashboard route answers 403 until the admin exists
    });
  }, [isSignedIn, getToken]);

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

  return <Outlet />;
}

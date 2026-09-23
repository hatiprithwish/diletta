import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { useAuth } from "@clerk/tanstack-react-start";
import { useEffect, useRef } from "react";
import { Button } from "@/shadcn/ui/button";
import { apiClient } from "@/providers/apiClient";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const syncedRef = useRef(false);

  useEffect(() => {
    if (!isSignedIn || syncedRef.current) return;
    syncedRef.current = true;
    apiClient("/users/clerk-sync", getToken, { method: "POST" }).catch(() => {
      // Non-fatal — user may already exist; errors logged on server
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

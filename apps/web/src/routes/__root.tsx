import { createRootRouteWithContext, Outlet, HeadContent, Scripts } from "@tanstack/react-router";
import { ClerkProvider } from "@clerk/tanstack-react-start";
import * as Sentry from "@sentry/tanstackstart-react";
import type { QueryClient } from "@tanstack/react-query";
import appCss from "../styles.css?url";
import type { ReactNode } from "react";
import { Toaster } from "../shadcn/ui/sonner";
import { ThemeProvider } from "../providers/ThemeProvider";

interface RouterContext {
  queryClient: QueryClient;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}

function RootErrorComponent({ error }: { error: unknown }) {
  Sentry.captureException(error);
  return (
    <div>
      <h1>Something went wrong</h1>
      <pre>{error instanceof Error ? error.message : String(error)}</pre>
    </div>
  );
}

function NotFoundComponent() {
  return <div>404 — page not found</div>;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: () => (
    <RootDocument>
      <ThemeProvider defaultTheme="system" storageKey="app-theme">
        <ClerkProvider
          publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
          signInUrl="/auth/sign-in"
          signUpUrl="/auth/sign-up"
        >
          <Outlet />
        </ClerkProvider>
      </ThemeProvider>
    </RootDocument>
  ),
  errorComponent: ({ error }) => <RootErrorComponent error={error} />,
  notFoundComponent: NotFoundComponent,
});

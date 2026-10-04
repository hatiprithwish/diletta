import { createRootRouteWithContext, Outlet, HeadContent, Scripts } from "@tanstack/react-router";
import { ClerkProvider } from "@clerk/tanstack-react-start";
import * as Sentry from "@sentry/tanstackstart-react";
import type { QueryClient } from "@tanstack/react-query";
import appCss from "../styles.css?url";
import type { ReactNode } from "react";
import { Toaster } from "@app/ui/components/sonner";
import { TooltipProvider } from "@app/ui/components/tooltip";
import { ThemeProvider, useTheme } from "../providers/ThemeProvider";

const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wdth,wght@0,75..100,400..700;1,75..100,400..700&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&display=swap";

interface RouterContext {
  queryClient: QueryClient;
}

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} />;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider defaultTheme="system" storageKey="app-theme">
          <TooltipProvider>
            {children}
            <ThemedToaster />
          </TooltipProvider>
        </ThemeProvider>
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
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: FONTS_URL },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: () => (
    <RootDocument>
      <ClerkProvider
        publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}
        signInUrl="/auth/sign-in"
        signUpUrl="/auth/sign-up"
      >
        <Outlet />
      </ClerkProvider>
    </RootDocument>
  ),
  errorComponent: ({ error }) => <RootErrorComponent error={error} />,
  notFoundComponent: NotFoundComponent,
});

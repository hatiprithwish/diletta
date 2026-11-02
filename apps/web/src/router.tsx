import * as Sentry from "@sentry/tanstackstart-react";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { createQueryClient } from "./providers/queryClient";
import { QueryClientProvider, dehydrate, HydrationBoundary } from "@tanstack/react-query";

export function getRouter() {
  return createRouter();
}

export function createRouter() {
  const queryClient = createQueryClient();

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <HydrationBoundary state={dehydrate(queryClient)}>{children}</HydrationBoundary>
      </QueryClientProvider>
    ),
  });

  if (!router.isServer) {
    // DEV_NOTE: No PII (M6-6, docs/runbooks/observability.md): the dashboard shows chat text, user names and emails,
    // so nothing identifying is sent and Replay masks every text and blocks every image or video
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      sendDefaultPii: false,
      integrations: [
        Sentry.tanstackRouterBrowserTracingIntegration(router),
        Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }),
        Sentry.feedbackIntegration({ colorScheme: "system" }),
      ],
      enableLogs: true,
      tracesSampleRate: 0.1,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
    });
  }

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}

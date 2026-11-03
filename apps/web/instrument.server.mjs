import * as Sentry from "@sentry/tanstackstart-react";

// DEV_NOTE: No PII (M6-6, docs/runbooks/observability.md): server requests carry the admin's Clerk session cookie
Sentry.init({
  dsn: process.env.VITE_SENTRY_DSN,
  sendDefaultPii: false,
  enableLogs: true,
  tracesSampleRate: 0.1,
});

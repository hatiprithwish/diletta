// DEV_NOTE: Tanstack Start Server entry point.

import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";

const handler = createStartHandler(defaultStreamHandler);

export default createServerEntry(
  wrapFetchWithSentry({
    fetch: (request: Request) => handler(request),
  }),
);

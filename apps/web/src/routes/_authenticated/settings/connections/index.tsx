import { createFileRoute } from "@tanstack/react-router";
import { ConnectionsPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/settings/connections/")({
  component: ConnectionsPage,
});

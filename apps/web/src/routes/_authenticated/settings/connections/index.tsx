import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/settings/connections/")({
  component: SettingsConnectionsPage,
});

function SettingsConnectionsPage() {
  return <PageHeader title="Connections" description="How the assistant reaches your app" />;
}

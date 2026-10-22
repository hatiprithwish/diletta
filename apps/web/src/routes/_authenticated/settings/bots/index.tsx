import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/settings/bots/")({
  component: SettingsBotsPage,
});

function SettingsBotsPage() {
  return (
    <PageHeader
      title="Bots"
      description="Each bot has its own configuration, tests and dashboards"
    />
  );
}

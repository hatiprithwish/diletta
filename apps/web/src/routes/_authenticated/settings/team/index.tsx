import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/settings/team/")({
  component: SettingsTeamPage,
});

function SettingsTeamPage() {
  return <PageHeader title="Team" description="People who can use this dashboard" />;
}

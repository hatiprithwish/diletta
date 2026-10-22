import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/overview/")({
  component: OverviewPage,
});

function OverviewPage() {
  return <PageHeader title="Overview" description="Last 30 days across all your bots" />;
}

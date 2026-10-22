import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/impact/")({
  component: ImpactPage,
});

function ImpactPage() {
  return <PageHeader title="Impact" description="Time the assistant saved your team" />;
}

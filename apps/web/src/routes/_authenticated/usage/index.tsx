import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/usage/")({
  component: UsagePage,
});

function UsagePage() {
  return <PageHeader title="Usage" description="Model spend on your own provider key" />;
}

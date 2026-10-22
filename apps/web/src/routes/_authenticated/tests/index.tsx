import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/tests/")({
  component: TestsPage,
});

function TestsPage() {
  return (
    <PageHeader
      title="Tests"
      description="Run against your staging environment before a configuration goes live"
    />
  );
}

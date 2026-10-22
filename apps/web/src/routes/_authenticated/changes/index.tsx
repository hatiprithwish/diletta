import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/changes/")({
  component: ChangesPage,
});

function ChangesPage() {
  return (
    <PageHeader
      title="Changes"
      description="Writes the assistant proposed, with approvals and checks"
    />
  );
}

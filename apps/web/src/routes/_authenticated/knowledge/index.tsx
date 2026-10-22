import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/knowledge/")({
  component: KnowledgePage,
});

function KnowledgePage() {
  return (
    <PageHeader
      title="Knowledge"
      description="What the assistant can read, and the gaps it ran into"
    />
  );
}

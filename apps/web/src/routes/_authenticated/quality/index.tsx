import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/quality/")({
  component: QualityPage,
});

function QualityPage() {
  return (
    <PageHeader
      title="Quality"
      description="Problems found in real conversations, from users, admins and automatic checks"
    />
  );
}

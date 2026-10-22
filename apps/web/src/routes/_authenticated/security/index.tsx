import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/security/")({
  component: SecurityPage,
});

function SecurityPage() {
  return (
    <PageHeader
      title="Security"
      description="Identity, encryption, data retention and the audit trail"
    />
  );
}

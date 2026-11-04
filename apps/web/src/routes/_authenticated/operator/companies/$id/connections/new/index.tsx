import { createFileRoute } from "@tanstack/react-router";
import { ConnectionPage } from "../../../-Connections";

export const Route = createFileRoute("/_authenticated/operator/companies/$id/connections/new/")({
  component: NewConnectionPage,
});

function NewConnectionPage() {
  const { id } = Route.useParams();
  return <ConnectionPage companyPublicId={id} connectionPublicId={null} />;
}

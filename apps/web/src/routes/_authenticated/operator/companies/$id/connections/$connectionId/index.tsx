import { createFileRoute } from "@tanstack/react-router";
import { ConnectionPage } from "../../../-Connections";

export const Route = createFileRoute(
  "/_authenticated/operator/companies/$id/connections/$connectionId/",
)({
  component: EditConnectionPage,
});

function EditConnectionPage() {
  const { id, connectionId } = Route.useParams();
  return <ConnectionPage companyPublicId={id} connectionPublicId={connectionId} />;
}

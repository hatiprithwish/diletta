import { createFileRoute } from "@tanstack/react-router";
import { ToolPage } from "../../../-Tools";

export const Route = createFileRoute("/_authenticated/operator/companies/$id/tools/new/")({
  component: NewToolPage,
});

function NewToolPage() {
  const { id } = Route.useParams();
  return <ToolPage companyPublicId={id} toolPublicId={null} />;
}

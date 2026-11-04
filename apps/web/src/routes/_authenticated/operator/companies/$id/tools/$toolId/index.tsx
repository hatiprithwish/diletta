import { createFileRoute } from "@tanstack/react-router";
import { ToolPage } from "../../../-Tools";

// DEV_NOTE: One version of a tool (a draft is edited here; an active or disabled one is read-only)
export const Route = createFileRoute("/_authenticated/operator/companies/$id/tools/$toolId/")({
  component: ToolVersionPage,
});

function ToolVersionPage() {
  const { id, toolId } = Route.useParams();
  return <ToolPage companyPublicId={id} toolPublicId={toolId} />;
}

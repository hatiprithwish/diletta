import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { KnowledgeSourcePage } from "../-Components";

// DEV_NOTE: One source with its documents (M4-7); the documents' page stays in the URL
export const Route = createFileRoute("/_authenticated/knowledge/$id/")({
  validateSearch: Schemas.ZKnowledgeSourcePageSearch,
  component: KnowledgeSourceRoute,
});

function KnowledgeSourceRoute() {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  return <KnowledgeSourcePage publicId={id} search={search} />;
}

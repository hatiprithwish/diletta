import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { KnowledgePage } from "./-Components";

export const Route = createFileRoute("/_authenticated/knowledge/")({
  validateSearch: Schemas.ZKnowledgePageSearch,
  component: KnowledgeIndexPage,
});

function KnowledgeIndexPage() {
  const search = Route.useSearch();
  return <KnowledgePage search={search} />;
}

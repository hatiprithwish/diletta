import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { QualityPage } from "../-Components";

// DEV_NOTE: The list with one issue open next to it (DESIGN.md §6); the tab and page stay in the URL
export const Route = createFileRoute("/_authenticated/quality/$id/")({
  validateSearch: Schemas.ZQualityPageSearch,
  component: QualityIssuePage,
});

function QualityIssuePage() {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  return <QualityPage search={search} selectedId={id} />;
}

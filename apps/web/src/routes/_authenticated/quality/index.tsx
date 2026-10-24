import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { QualityPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/quality/")({
  validateSearch: Schemas.ZQualityPageSearch,
  component: QualityListPage,
});

function QualityListPage() {
  const search = Route.useSearch();
  return <QualityPage search={search} selectedId={null} />;
}

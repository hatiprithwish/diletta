import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { ChangesPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/changes/")({
  validateSearch: Schemas.ZChangesPageSearch,
  component: ChangesListPage,
});

function ChangesListPage() {
  const search = Route.useSearch();
  return <ChangesPage search={search} selectedId={null} />;
}

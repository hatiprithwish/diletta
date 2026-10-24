import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { ChangesPage } from "../-Components";

// DEV_NOTE: The list with one change open next to it (DESIGN.md §6); the filters stay in the URL. A conversation's
// Open change lands here too (M4-4), with no filters.
export const Route = createFileRoute("/_authenticated/changes/$id/")({
  validateSearch: Schemas.ZChangesPageSearch,
  component: ChangePage,
});

function ChangePage() {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  return <ChangesPage search={search} selectedId={id} />;
}

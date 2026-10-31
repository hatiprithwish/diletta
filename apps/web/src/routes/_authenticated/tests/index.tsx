import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { TestsPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/tests/")({
  validateSearch: Schemas.ZTestsPageSearch,
  component: TestsListPage,
});

function TestsListPage() {
  const search = Route.useSearch();
  return <TestsPage search={search} />;
}

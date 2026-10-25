import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { TestRunPage } from "../-Components";

// DEV_NOTE: One run, with the open case's attempts next to its cases (DESIGN.md §6); page and case stay in the URL
export const Route = createFileRoute("/_authenticated/tests/$id/")({
  validateSearch: Schemas.ZTestRunPageSearch,
  component: TestRunRoutePage,
});

function TestRunRoutePage() {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  return <TestRunPage publicId={id} search={search} />;
}

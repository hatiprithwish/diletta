import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { OperatorCompaniesPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/operator/companies/")({
  validateSearch: Schemas.ZOperatorCompaniesPageSearch,
  component: OperatorCompaniesListPage,
});

function OperatorCompaniesListPage() {
  const search = Route.useSearch();
  return <OperatorCompaniesPage search={search} />;
}

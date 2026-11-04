import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { OperatorCompanyPage } from "../-Components";

// DEV_NOTE: One company's operator page; its section stays in the URL (?tab=)
export const Route = createFileRoute("/_authenticated/operator/companies/$id/")({
  validateSearch: Schemas.ZOperatorCompanyPageSearch,
  component: OperatorCompanyDetailPage,
});

function OperatorCompanyDetailPage() {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  return <OperatorCompanyPage companyPublicId={id} search={search} />;
}

import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { SecurityPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/security/")({
  validateSearch: Schemas.ZSecurityPageSearch,
  component: SecurityRoutePage,
});

function SecurityRoutePage() {
  const search = Route.useSearch();
  return <SecurityPage search={search} />;
}

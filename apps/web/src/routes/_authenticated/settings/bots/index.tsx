import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { BotsPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/settings/bots/")({
  validateSearch: Schemas.ZBotsPageSearch,
  component: SettingsBotsPage,
});

function SettingsBotsPage() {
  const search = Route.useSearch();
  return <BotsPage search={search} />;
}

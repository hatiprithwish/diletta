import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { ConversationsPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/conversations/")({
  validateSearch: Schemas.ZConversationsPageSearch,
  component: ConversationsListPage,
});

function ConversationsListPage() {
  const search = Route.useSearch();
  return <ConversationsPage search={search} selectedId={null} />;
}

import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { ConversationsPage } from "../-Components";

// DEV_NOTE: The list with one conversation open next to it (DESIGN.md §6); the filters stay in the URL
export const Route = createFileRoute("/_authenticated/conversations/$id/")({
  validateSearch: Schemas.ZConversationsPageSearch,
  component: ConversationPage,
});

function ConversationPage() {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  return <ConversationsPage search={search} selectedId={id} />;
}

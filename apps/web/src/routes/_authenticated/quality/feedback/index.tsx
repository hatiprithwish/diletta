import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { FeedbackThemesPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/quality/feedback/")({
  validateSearch: Schemas.ZFeedbackThemesPageSearch,
  component: FeedbackThemesListPage,
});

function FeedbackThemesListPage() {
  const search = Route.useSearch();
  return <FeedbackThemesPage search={search} selectedId={null} />;
}

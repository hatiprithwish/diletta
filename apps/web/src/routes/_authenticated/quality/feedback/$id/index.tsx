import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { FeedbackThemesPage } from "../-Components";

// DEV_NOTE: The themes with one open next to them (DESIGN.md §6); the thumb, tab and page stay in the URL
export const Route = createFileRoute("/_authenticated/quality/feedback/$id/")({
  validateSearch: Schemas.ZFeedbackThemesPageSearch,
  component: FeedbackThemePage,
});

function FeedbackThemePage() {
  const search = Route.useSearch();
  const { id } = Route.useParams();
  return <FeedbackThemesPage search={search} selectedId={id} />;
}

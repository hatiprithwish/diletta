import { createFileRoute } from "@tanstack/react-router";
import { BotVersionPage } from "../../../-Editor";

// DEV_NOTE: A blank first draft, for a bot with no version to copy. Saving it creates the version and opens it.
export const Route = createFileRoute("/_authenticated/settings/bots/$id/versions/new/")({
  component: SettingsNewBotVersionPage,
});

function SettingsNewBotVersionPage() {
  const { id } = Route.useParams();
  return <BotVersionPage chatbotPublicId={id} versionPublicId={null} />;
}

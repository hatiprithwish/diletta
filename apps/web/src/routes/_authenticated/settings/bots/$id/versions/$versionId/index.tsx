import { createFileRoute } from "@tanstack/react-router";
import { BotVersionPage } from "../../../-Editor";

export const Route = createFileRoute("/_authenticated/settings/bots/$id/versions/$versionId/")({
  component: SettingsBotVersionPage,
});

function SettingsBotVersionPage() {
  const { id, versionId } = Route.useParams();
  return <BotVersionPage key={versionId} chatbotPublicId={id} versionPublicId={versionId} />;
}

import { createFileRoute } from "@tanstack/react-router";
import { TeamPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/settings/team/")({
  component: TeamPage,
});

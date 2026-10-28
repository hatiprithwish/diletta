import { createFileRoute } from "@tanstack/react-router";
import { ModelKeysPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/settings/model-keys/")({
  component: ModelKeysPage,
});

import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/settings/model-keys/")({
  component: SettingsModelKeysPage,
});

function SettingsModelKeysPage() {
  return (
    <PageHeader
      title="Model keys"
      description="Your provider keys, required for every model call"
    />
  );
}

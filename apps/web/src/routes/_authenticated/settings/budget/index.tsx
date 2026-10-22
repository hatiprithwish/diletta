import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

export const Route = createFileRoute("/_authenticated/settings/budget/")({
  component: SettingsBudgetPage,
});

function SettingsBudgetPage() {
  return <PageHeader title="Budget" description="Spending limit across all bots" />;
}

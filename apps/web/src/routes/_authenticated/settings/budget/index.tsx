import { createFileRoute } from "@tanstack/react-router";
import { BudgetPage } from "./-Components";

export const Route = createFileRoute("/_authenticated/settings/budget/")({
  component: BudgetPage,
});

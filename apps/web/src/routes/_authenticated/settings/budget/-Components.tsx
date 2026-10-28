import { useForm } from "@tanstack/react-form";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
import { Progress } from "@app/ui/components/progress";
import { Skeleton } from "@app/ui/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { SectionHeader } from "@/components/section-header";
import Utilities from "@/utils";
import { useSpendingBudget, useUpdateSpendingBudget } from "./-data";

// DEV_NOTE: The bar's ticks (DESIGN.md §5 Budget bar), at the shares where alerts will fire
const BUDGET_TICKS = [50, 80];

const PERIOD_DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

// DEV_NOTE: The whole /settings/budget body (DESIGN.md dashboard-Budget): the budget per billing period and what this one
// has used. The 50% / 80% alerts aren't sent yet (docs/runbooks/budget.md Known gaps), so the copy doesn't promise them.
export function BudgetPage() {
  const query = useSpendingBudget();
  const spendingBudget = query.data?.spendingBudget;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Budget" description="Spending limit across all bots" />
      <section className="flex flex-col gap-4" aria-label="Spending budget">
        <SectionHeader title="Spending budget" />
        {query.isPending && <Skeleton className="h-64 rounded-xl" aria-label="Loading" />}
        {!query.isPending && !spendingBudget && (
          <PageError title="Budget didn't load" onRetry={() => void query.refetch()} />
        )}
        {spendingBudget && (
          <BudgetForm key={spendingBudget.budgetUsd} spendingBudget={spendingBudget} />
        )}
      </section>
    </div>
  );
}

// DEV_NOTE: The amount as typed, checked with the same rule the backend applies (positive, whole cents, at most the cap)
function amountIssue(value: string): string | undefined {
  if (value.trim() === "") return "Enter an amount.";
  const parsed = Schemas.ZSpendingBudgetUsd.safeParse(Number(value.trim()));
  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? "Enter an amount.");
}

const errorsOf = (errors: unknown[]) => errors.map((message) => ({ message: String(message) }));

function BudgetForm({ spendingBudget }: Schemas.DashboardBudgetFormProps) {
  const update = useUpdateSpendingBudget();
  const savedAmount = Number(spendingBudget.budgetUsd).toFixed(2);
  const form = useForm({
    defaultValues: { amount: savedAmount },
    onSubmit: async ({ value }) => {
      await update.mutateAsync({ spendingBudgetUsd: Number(value.amount.trim()) });
    },
  });

  return (
    <form
      className="flex flex-col gap-6 rounded-xl border px-[22px] py-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().catch(() => undefined);
      }}
    >
      <form.Field name="amount" validators={{ onChange: ({ value }) => amountIssue(value) }}>
        {(field) => (
          <Field className="max-w-sm" data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor="budget-amount">Budget per billing period (USD)</FieldLabel>
            <Input
              id="budget-amount"
              name={field.name}
              inputMode="decimal"
              className="tabular-nums"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            <FieldDescription>
              Across all bots, including test runs.
              {spendingBudget.isDefault && " This is the default until you choose."}
            </FieldDescription>
            <FieldError errors={errorsOf(field.state.meta.errors)} />
          </Field>
        )}
      </form.Field>
      <BudgetUsage spendingBudget={spendingBudget} />
      <p className="text-caption text-muted-foreground">
        At 100% the assistant stops calling models until the next period or a higher budget. Changes
        apply within a minute.
      </p>
      <form.Subscribe
        selector={(state) =>
          [state.values.amount.trim() !== savedAmount, state.canSubmit, state.isSubmitting] as const
        }
      >
        {([isChanged, canSubmit, isSubmitting]) => (
          <div>
            <Button
              type="submit"
              variant="outline"
              disabled={!isChanged || !canSubmit || isSubmitting}
            >
              {isSubmitting ? "Saving…" : "Save budget"}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

// DEV_NOTE: This billing period (the UTC month): used so far against the budget in force, the bar capped at full
function BudgetUsage({ spendingBudget }: Schemas.DashboardBudgetUsageProps) {
  const used = Number(spendingBudget.usedUsd);
  const budget = Number(spendingBudget.budgetUsd);
  const percent = budget > 0 ? Math.round((used / budget) * 100) : 0;
  const lastDay = new Date(Date.parse(spendingBudget.periodEnd) - 1);

  return (
    <div className="flex max-w-xl flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-body text-foreground">
          Billing period{" "}
          <span className="text-muted-foreground">
            {PERIOD_DAY_FORMAT.format(new Date(spendingBudget.periodStart))} –{" "}
            {PERIOD_DAY_FORMAT.format(lastDay)} (UTC)
          </span>
        </p>
        <p className="text-body tabular-nums text-foreground">
          {Utilities.formatUsd(spendingBudget.usedUsd)} used
          <span className="text-muted-foreground"> · {percent}%</span>
        </p>
      </div>
      <div className="relative">
        <Progress value={Math.min(percent, 100)} aria-label={`${percent}% of the budget used`} />
        {BUDGET_TICKS.map((tick) => (
          <span
            key={tick}
            aria-hidden
            className="absolute inset-y-0 w-px bg-subtle-foreground"
            style={{ left: `${tick}%` }}
          />
        ))}
      </div>
      <p className="text-caption text-muted-foreground tabular-nums">
        of {Utilities.formatUsd(spendingBudget.budgetUsd)}
      </p>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { PageHeader } from "@/components/page-header";
import { PageError, PageLoading } from "@/components/page-state";
import { RangeSelect } from "@/components/range-select";
import { useUsage } from "./-data";
import { ByModel, ByUse, SpendPerDay, UsageMetrics } from "./-Components";

export const Route = createFileRoute("/_authenticated/usage/")({
  validateSearch: Schemas.ZInsightsPageSearch,
  component: UsagePage,
});

const RANGE_OPTIONS = Object.values(Schemas.InsightsRangeEnum).map((value) => ({
  value,
  label: Schemas.INSIGHTS_RANGE_LABEL_MAP[value],
}));

function UsagePage() {
  const range =
    Route.useSearch({ select: (search) => search.range }) ?? Schemas.DEFAULT_INSIGHTS_RANGE;
  const navigate = Route.useNavigate();
  const query = useUsage(range);
  const usage = query.data?.usage;

  return (
    <div className="flex flex-col gap-9">
      <PageHeader title="Usage" description="Model spend on your own provider key">
        <RangeSelect
          value={range}
          options={RANGE_OPTIONS}
          onValueChange={(value) =>
            void navigate({ search: Schemas.ZInsightsPageSearch.parse({ range: value }) })
          }
        />
      </PageHeader>
      {query.isPending && <PageLoading />}
      {!query.isPending && !usage && (
        <PageError title="Usage didn't load" onRetry={() => void query.refetch()} />
      )}
      {usage && (
        <>
          <UsageMetrics usage={usage} />
          <SpendPerDay usage={usage} />
          <div className="grid gap-9 lg:grid-cols-2">
            <ByUse usage={usage} />
            <ByModel usage={usage} />
          </div>
          <p className="text-caption text-muted-foreground">Numbers update every hour.</p>
        </>
      )}
    </div>
  );
}

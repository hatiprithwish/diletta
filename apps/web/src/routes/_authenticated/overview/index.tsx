import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { PageHeader } from "@/components/page-header";
import { PageError, PageLoading } from "@/components/page-state";
import { RangeSelect } from "@/components/range-select";
import { useOverview } from "./-data";
import {
  ConversationsPerDay,
  LiveConfiguration,
  MonthSpend,
  NeedsAttention,
  OverviewMetrics,
} from "./-Components";

export const Route = createFileRoute("/_authenticated/overview/")({
  validateSearch: Schemas.ZInsightsPageSearch,
  component: OverviewPage,
});

const RANGE_OPTIONS = Object.values(Schemas.InsightsRangeEnum).map((value) => ({
  value,
  label: Schemas.INSIGHTS_RANGE_LABEL_MAP[value],
}));

function OverviewPage() {
  const range =
    Route.useSearch({ select: (search) => search.range }) ?? Schemas.DEFAULT_INSIGHTS_RANGE;
  const navigate = Route.useNavigate();
  const query = useOverview(range);
  const overview = query.data?.overview;

  return (
    <div className="flex flex-col gap-9">
      <PageHeader
        title="Overview"
        description={`Last ${Schemas.INSIGHTS_RANGE_LABEL_MAP[range]} across all your bots`}
      >
        <RangeSelect
          value={range}
          options={RANGE_OPTIONS}
          onValueChange={(value) =>
            void navigate({ search: Schemas.ZInsightsPageSearch.parse({ range: value }) })
          }
        />
      </PageHeader>
      {query.isPending && <PageLoading />}
      {!query.isPending && !overview && (
        <PageError title="The overview didn't load" onRetry={() => void query.refetch()} />
      )}
      {overview && (
        <>
          <OverviewMetrics overview={overview} />
          <div className="grid gap-9 lg:grid-cols-2">
            <ConversationsPerDay overview={overview} />
            <MonthSpend overview={overview} />
            <NeedsAttention overview={overview} />
            <LiveConfiguration overview={overview} />
          </div>
          <p className="text-caption text-muted-foreground">Numbers update every hour.</p>
        </>
      )}
    </div>
  );
}

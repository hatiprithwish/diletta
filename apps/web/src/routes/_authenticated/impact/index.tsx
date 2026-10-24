import { createFileRoute } from "@tanstack/react-router";
import * as Schemas from "@app/schemas";
import { PageHeader } from "@/components/page-header";
import { PageError, PageLoading } from "@/components/page-state";
import { RangeSelect } from "@/components/range-select";
import { useImpact } from "./-data";
import { ByTask, HoursPerWeek, ImpactMetrics } from "./-Components";

export const Route = createFileRoute("/_authenticated/impact/")({
  validateSearch: Schemas.ZImpactPageSearch,
  component: ImpactPage,
});

const RANGE_OPTIONS = Object.values(Schemas.ImpactRangeEnum).map((value) => ({
  value,
  label: Schemas.IMPACT_RANGE_LABEL_MAP[value],
}));

function ImpactPage() {
  const range =
    Route.useSearch({ select: (search) => search.range }) ?? Schemas.DEFAULT_IMPACT_RANGE;
  const navigate = Route.useNavigate();
  const query = useImpact(range);
  const impact = query.data?.impact;

  return (
    <div className="flex flex-col gap-9">
      <PageHeader title="Impact" description="Time the assistant saved your team">
        <RangeSelect
          value={range}
          options={RANGE_OPTIONS}
          onValueChange={(value) =>
            void navigate({ search: Schemas.ZImpactPageSearch.parse({ range: value }) })
          }
        />
      </PageHeader>
      {query.isPending && <PageLoading />}
      {!query.isPending && !impact && (
        <PageError title="Impact didn't load" onRetry={() => void query.refetch()} />
      )}
      {impact && (
        <>
          <ImpactMetrics impact={impact} range={range} />
          <HoursPerWeek impact={impact} />
          <ByTask impact={impact} />
          <p className="text-caption text-muted-foreground">Numbers update every hour.</p>
        </>
      )}
    </div>
  );
}

import * as Schemas from "@app/schemas";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@app/ui/components/table";
import { BarChart } from "@/components/bar-chart";
import { MetricCell, MetricStrip } from "@/components/metric-strip";
import { SectionHeader } from "@/components/section-header";
import Utilities from "@/utils";

const Tone = Schemas.DashboardToneEnum;

// DEV_NOTE: The cost per conversation's change as money ("−$0.03"); a drop is good news
function costChange(value: string | null, previousValue: string | null) {
  if (value === null || previousValue === null) return { note: undefined, tone: Tone.Neutral };
  const change = Number(value) - Number(previousValue);
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  return {
    note: `${sign}${Utilities.formatUsd(String(Math.abs(change)))} vs last period`,
    tone: change < 0 ? Tone.Positive : change > 0 ? Tone.Negative : Tone.Neutral,
  };
}

export function UsageMetrics({ usage }: Schemas.DashboardUsageSectionProps) {
  const callsChange = Utilities.formatChange(
    usage.modelCalls.value,
    usage.modelCalls.previousValue,
  );
  const perConversation = costChange(
    usage.costPerConversation.valueUsd,
    usage.costPerConversation.previousValueUsd,
  );

  return (
    <MetricStrip>
      <MetricCell
        label="Spend this period"
        value={Utilities.formatUsd(usage.spend.valueUsd)}
        note={`Includes ${Utilities.formatUsd(usage.spend.testRunsUsd)} of test runs`}
      />
      <MetricCell
        label="Model calls"
        value={Utilities.formatCount(usage.modelCalls.value)}
        note={callsChange ? `${callsChange} vs last period` : undefined}
      />
      <MetricCell
        label="Avg cost per conversation"
        value={
          usage.costPerConversation.valueUsd === null
            ? "—"
            : Utilities.formatUsd(usage.costPerConversation.valueUsd)
        }
        note={perConversation.note}
        noteTone={perConversation.tone}
      />
    </MetricStrip>
  );
}

export function SpendPerDay({ usage }: Schemas.DashboardUsageSectionProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader title="Spend per day" />
      <BarChart
        ariaLabel="Spend per day"
        data={usage.spendPerDay.map((day) => ({
          key: day.day,
          label: Utilities.formatDay(day.day),
          value: Number(day.costUsd),
          valueLabel: Utilities.formatUsd(day.costUsd),
        }))}
      />
    </section>
  );
}

const HEAD_CLASS = "h-auto px-4 py-3 text-caption font-normal text-muted-foreground";
const CELL_CLASS = "px-4 py-[13px] text-body";

export function ByUse({ usage }: Schemas.DashboardUsageSectionProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader title="By use" />
      <div className="overflow-hidden rounded-xl border">
        {usage.byUse.length === 0 ? (
          <p className="px-4 py-5 text-body text-muted-foreground">No model calls in this range.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD_CLASS}>Used for</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Calls</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Tokens</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.byUse.map((row) => (
                <TableRow key={row.use}>
                  <TableCell className={CELL_CLASS}>{row.useLabel}</TableCell>
                  <TableCell className={`${CELL_CLASS} text-right`}>
                    {Utilities.formatCount(row.calls)}
                  </TableCell>
                  <TableCell className={`${CELL_CLASS} text-right`}>
                    {row.tokens === 0 ? "—" : Utilities.formatTokens(row.tokens)}
                  </TableCell>
                  <TableCell className={`${CELL_CLASS} text-right`}>
                    {row.isIncluded ? "Included" : Utilities.formatUsd(row.costUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

export function ByModel({ usage }: Schemas.DashboardUsageSectionProps) {
  const billedBy = [
    ...new Set(usage.byModel.filter((row) => !row.isIncluded).map((row) => row.providerLabel)),
  ];

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader
        title="By model"
        description={
          billedBy.length > 0 ? `Billed by ${billedBy.join(" and ")} on your key.` : undefined
        }
      />
      <div className="overflow-hidden rounded-xl border">
        {usage.byModel.length === 0 ? (
          <p className="px-4 py-5 text-body text-muted-foreground">No model calls in this range.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD_CLASS}>Model</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Calls</TableHead>
                <TableHead className={`${HEAD_CLASS} text-right`}>Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.byModel.map((row) => (
                <TableRow key={`${row.provider}/${row.model}`}>
                  <TableCell className={CELL_CLASS}>
                    <span className="font-mono text-mono-value">{row.model}</span>
                  </TableCell>
                  <TableCell className={`${CELL_CLASS} text-right`}>
                    {Utilities.formatCount(row.calls)}
                  </TableCell>
                  <TableCell className={`${CELL_CLASS} text-right`}>
                    {row.isIncluded ? "Included" : Utilities.formatUsd(row.costUsd)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

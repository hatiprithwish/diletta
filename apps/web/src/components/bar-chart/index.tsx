import { Bar, BarChart as RechartsBarChart, XAxis } from "recharts";
import type * as Schemas from "@app/schemas";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@app/ui/components/chart";

const CHART_CONFIG = {
  value: { label: "Value", color: "var(--primary)" },
} satisfies ChartConfig;

// DEV_NOTE: The pages' bar chart (shadcn Chart, DESIGN.md §5): lime bars, no grid or y axis, the first, middle and last
// labels on the x axis, the bar's formatted value in its tooltip. A bar of 0 still takes its slot, so days line up.
export function BarChart({ data, ariaLabel }: Schemas.DashboardBarChartProps) {
  const tickKeys = new Set(
    [data[0], data[Math.floor((data.length - 1) / 2)], data.at(-1)]
      .filter((datum) => datum !== undefined)
      .map((datum) => datum.key),
  );

  return (
    <div className="rounded-xl border px-[22px] pt-5 pb-3" role="img" aria-label={ariaLabel}>
      <ChartContainer config={CHART_CONFIG} className="aspect-auto h-44 w-full">
        <RechartsBarChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis
            dataKey="key"
            tickLine={false}
            axisLine={false}
            interval={0}
            tickMargin={10}
            tickFormatter={(key: string) =>
              tickKeys.has(key) ? (data.find((datum) => datum.key === key)?.label ?? "") : ""
            }
          />
          <ChartTooltip
            cursor={false}
            content={({ active, payload }) => {
              const datum = payload?.[0]?.payload as Schemas.DashboardBarDatum | undefined;
              if (!active || !datum) return null;
              return (
                <div className="rounded-lg border bg-background px-2.5 py-1.5 text-caption">
                  <span className="text-muted-foreground">{datum.label}</span>{" "}
                  <span className="font-medium text-foreground">{datum.valueLabel}</span>
                </div>
              );
            }}
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={3} minPointSize={1} />
        </RechartsBarChart>
      </ChartContainer>
    </div>
  );
}

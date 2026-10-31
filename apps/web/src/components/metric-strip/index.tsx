import type { PropsWithChildren } from "react";
import * as Schemas from "@app/schemas";
import { cn } from "@app/ui/lib/utils";

const NOTE_TONE_CLASS: Record<Schemas.DashboardToneEnum, string> = {
  [Schemas.DashboardToneEnum.Neutral]: "text-muted-foreground",
  [Schemas.DashboardToneEnum.Positive]: "text-success",
  [Schemas.DashboardToneEnum.Negative]: "text-warning",
};

// DEV_NOTE: The metric strip (DESIGN.md §5): one bordered box, cells split by 1px dividers; on a narrow screen the
// cells stack and the dividers turn horizontal
export function MetricStrip({ children }: PropsWithChildren) {
  return (
    <div className="grid grid-cols-1 divide-y rounded-xl border sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-y-0">
      {children}
    </div>
  );
}

export function MetricCell({
  label,
  value,
  note,
  noteTone = Schemas.DashboardToneEnum.Neutral,
}: Schemas.DashboardMetricCellProps) {
  return (
    <div className="flex flex-col gap-2 px-[22px] py-5">
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="text-metric text-foreground">{value}</span>
      {note && <span className={cn("text-caption", NOTE_TONE_CLASS[noteTone])}>{note}</span>}
    </div>
  );
}

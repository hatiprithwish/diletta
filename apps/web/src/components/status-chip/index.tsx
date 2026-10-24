import * as Schemas from "@app/schemas";
import { Badge } from "@app/ui/components/badge";
import { cn } from "@app/ui/lib/utils";

const TONE_CLASS: Record<Schemas.DashboardChipToneEnum, string> = {
  [Schemas.DashboardChipToneEnum.Neutral]: "bg-muted text-muted-foreground",
  [Schemas.DashboardChipToneEnum.Success]: "bg-success-soft text-success",
  [Schemas.DashboardChipToneEnum.Warning]: "bg-warning-soft text-warning",
  [Schemas.DashboardChipToneEnum.Destructive]: "bg-destructive-soft text-destructive",
  [Schemas.DashboardChipToneEnum.Brand]: "bg-brand-soft text-brand-text",
};

// DEV_NOTE: A status chip (DESIGN.md §5): a Badge with a 6px dot in the text colour
export function StatusChip({ label, tone }: Schemas.DashboardStatusChipProps) {
  return (
    <Badge className={cn("gap-1.5", TONE_CLASS[tone])}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </Badge>
  );
}

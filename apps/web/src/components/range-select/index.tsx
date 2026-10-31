import type * as Schemas from "@app/schemas";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@app/ui/components/select";

// DEV_NOTE: The page header's range filter (DESIGN.md §5 dropdown filter): label muted, value in foreground
export function RangeSelect({ value, options, onValueChange }: Schemas.DashboardRangeSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label="Range" className="min-w-36">
        <span className="text-muted-foreground">Range</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

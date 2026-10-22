import { Checkbox } from "@app/ui/components/checkbox";
import { Button } from "@app/ui/components/button";
import { cn } from "@app/ui/lib/utils";
import type * as Schemas from "@app/schemas";
import ChangeOutcome from "@/components/ChangeOutcome";
import DiffLine from "@/components/DiffLine";

// DEV_NOTE: Bulk review (DESIGN.md §7 widget-Bulk): one row per record with a checkbox (ticked = approved with the
// card, unticked = rejected), the record's mono id and its change. One changed field across the card shows as two
// columns (old struck through, new on diff-new); more shows each record's diff lines. The first
// WIDGET_CHANGE_BULK_VISIBLE_ROWS rows show until "Show N more".
export default function ChangeRequestBulk({ card, actions }: Schemas.WidgetChangeCardProps) {
  const fields = new Set(card.records.flatMap((record) => record.lines.map((line) => line.field)));
  const isSingleField = fields.size === 1;
  const { isSending } = card;

  return (
    <div className="flex flex-col">
      {isSingleField && (
        <div className="grid grid-cols-[24px_minmax(0,1fr)_88px_88px] gap-2 border-t border-muted px-3.5 py-2 text-widget-row text-subtle-foreground">
          <span />
          <span>Record</span>
          <span className="font-mono">{[...fields][0]}</span>
          <span>New</span>
        </div>
      )}
      <ul className="flex flex-col">
        {card.records.map((record) => {
          const label = record.label ?? "New record";
          const line = record.lines[0];
          return (
            <li
              key={record.changeRequestPublicId}
              className={cn(
                "border-t border-muted px-3.5 py-2.5",
                !record.isIncluded && record.isProposed && "opacity-50",
              )}
            >
              <div
                className={
                  isSingleField
                    ? "grid grid-cols-[24px_minmax(0,1fr)_88px_88px] items-center gap-2"
                    : "flex items-start gap-2"
                }
              >
                <Checkbox
                  checked={record.isIncluded}
                  disabled={!record.isProposed || isSending}
                  onCheckedChange={() =>
                    actions.onToggleRecord(card.id, record.changeRequestPublicId)
                  }
                  aria-label={`Include ${label}`}
                />
                <span className="min-w-0 truncate font-mono text-mono-value text-foreground">
                  {label}
                </span>
                {isSingleField && line ? (
                  <>
                    <del className="truncate text-widget-row text-subtle-foreground">
                      {line.before ?? "empty"}
                    </del>
                    <ins className="w-fit max-w-full truncate rounded-md bg-diff-new px-1.5 py-0.5 text-widget-row text-foreground no-underline">
                      {line.after ?? "empty"}
                    </ins>
                  </>
                ) : (
                  <div className="flex min-w-0 grow flex-col gap-1">
                    {record.lines.map((recordLine) => (
                      <DiffLine key={recordLine.field} line={recordLine} />
                    ))}
                  </div>
                )}
              </div>
              {!record.isProposed && (
                <div className="pt-1.5 pl-8">
                  <ChangeOutcome outcome={record.outcome} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {card.hiddenCount > 0 && (
        <div className="border-t border-muted px-3.5 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => actions.onShowMore(card.id)}
            className="text-body"
          >
            Show {card.hiddenCount} more
          </Button>
        </div>
      )}
    </div>
  );
}

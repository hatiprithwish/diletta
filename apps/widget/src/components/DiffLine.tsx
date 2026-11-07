import type * as Schemas from "@app/schemas";
import ValueBlock from "@/components/ValueBlock";
import { isBlockValue } from "@/lib/changeRequestView";

// DEV_NOTE: One diff line (DESIGN.md §7): the field (muted, a machine value), the old value struck through, an arrow,
// the new value on diff-new. An empty value reads "empty". A value over several lines (code, or text past a line) can't sit beside its field: the field leads and each value is a scrollable block under it.
export default function DiffLine({ line }: Schemas.WidgetDiffLineProps) {
  if (isBlockValue(line.before) || isBlockValue(line.after)) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5 text-widget-row">
        <span className="truncate font-mono text-subtle-foreground">{line.field}</span>
        {line.before === null ? (
          <span className="text-muted-foreground">empty</span>
        ) : (
          <ValueBlock
            as="del"
            text={line.before}
            className="border border-muted text-subtle-foreground"
          />
        )}
        <span aria-hidden="true" className="text-muted-foreground">
          ↓
        </span>
        <span className="sr-only">changes to</span>
        {line.after === null ? (
          <span className="text-muted-foreground">empty</span>
        ) : (
          <ValueBlock as="ins" text={line.after} className="bg-diff-new text-foreground" />
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-baseline gap-2 text-widget-row">
      <span className="truncate font-mono text-subtle-foreground">{line.field}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
        {line.before === null ? (
          <span className="text-muted-foreground">empty</span>
        ) : (
          <del className="break-all text-subtle-foreground">{line.before}</del>
        )}
        <span aria-hidden="true" className="text-muted-foreground">
          →
        </span>
        <span className="sr-only">changes to</span>
        <ins className="rounded-md bg-diff-new px-1.5 py-0.5 break-all text-foreground no-underline">
          {line.after ?? "empty"}
        </ins>
      </span>
    </div>
  );
}

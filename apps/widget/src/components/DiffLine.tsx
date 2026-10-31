import type * as Schemas from "@app/schemas";

// DEV_NOTE: One diff line (DESIGN.md §7): the field (muted, a machine value), the old value struck through, an arrow,
// the new value on diff-new. An empty value reads "empty".
export default function DiffLine({ line }: Schemas.WidgetDiffLineProps) {
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

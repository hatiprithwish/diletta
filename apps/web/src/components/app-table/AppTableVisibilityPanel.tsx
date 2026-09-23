import { useState } from "react";
import { DotsThree, Eye, EyeSlash, MagnifyingGlass } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/shadcn/ui/popover";
import { AppTableColumn } from "./AppTable.types";
import { cn } from "@/lib/utils";

interface AppTableVisibilityPanelProps<TRow> {
  columns: AppTableColumn<TRow>[];
  columnVisibility: Record<string, boolean>;
  onToggle: (key: string) => void;
  onHideAll: () => void;
  onShowAll: () => void;
}

export function AppTableVisibilityPanel<TRow>({
  columns,
  columnVisibility,
  onToggle,
  onHideAll,
  onShowAll,
}: AppTableVisibilityPanelProps<TRow>) {
  const [search, setSearch] = useState("");

  const filtered = columns.filter((col) => col.header.toLowerCase().includes(search.toLowerCase()));

  const allHidden = columns.every((col) => !columnVisibility[col.key]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Show or hide columns"
        >
          <DotsThree className="h-4 w-4" weight="bold" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-72 p-0">
        {/* ─── Header ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-sm font-medium">Column visibility</span>
        </div>

        {/* ─── Search ──────────────────────────────────────────────────── */}
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
            <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search for a column..."
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
            />
          </div>
        </div>

        {/* ─── Show/Hide all ───────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs text-muted-foreground">
            {columns.filter((c) => columnVisibility[c.key]).length} shown
          </span>
          <button
            onClick={allHidden ? onShowAll : onHideAll}
            className="text-xs font-medium text-primary hover:underline"
          >
            {allHidden ? "Show all" : "Hide all"}
          </button>
        </div>

        {/* ─── Column list ─────────────────────────────────────────────── */}
        <ul className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-center text-xs text-muted-foreground">
              No columns found.
            </li>
          )}
          {filtered.map((col) => {
            const isVisible = !!columnVisibility[col.key];
            return (
              <li key={col.key}>
                <button
                  onClick={() => onToggle(col.key)}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-2 text-sm transition-colors hover:bg-secondary/50",
                    !isVisible && "text-muted-foreground",
                  )}
                >
                  <span>{col.header}</span>
                  {isVisible ? (
                    <Eye className="h-4 w-4 text-primary" />
                  ) : (
                    <EyeSlash className="h-4 w-4 text-muted-foreground/50" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

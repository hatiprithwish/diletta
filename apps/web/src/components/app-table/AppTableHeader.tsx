"use client";

import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowsDownUp, CaretDown, CaretUp, DotsSixVertical, Info } from "@phosphor-icons/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shadcn/ui/tooltip";
import { TableHead, TableHeader, TableRow } from "@/shadcn/ui/table";
import { AppTableColumn, AppTableSortDirection } from "./AppTable.types";
import { AppTableColumnMenu } from "./AppTableColumnMenu";
import { cn } from "@/lib/utils";
import {
  HEADER_ROW_CLASS,
  SORT_ICON_INACTIVE_CLASS,
  SORT_ICON_ACTIVE_CLASS,
  DRAG_HANDLE_CLASS,
} from "./utils";

export { arrayMove };

// ─── Sortable Header Cell ──────────────────────────────────────────────────

interface SortableHeaderCellProps<TRow> {
  column: AppTableColumn<TRow>;
  sortBy?: string;
  sortOrder?: AppTableSortDirection;
  onSort?: (col: string, dir: AppTableSortDirection) => void;
  stickyHeader?: boolean;
  onHideColumn: (key: string) => void;
}

function SortableHeaderCell<TRow>({
  column,
  sortBy,
  sortOrder,
  onSort,
  onHideColumn,
}: SortableHeaderCellProps<TRow>) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: column.key,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isSortable = !!column.sortKey && !!onSort;
  const isActive = column.sortKey === sortBy;

  const handleSortClick = () => {
    if (!isSortable || !column.sortKey) return;
    if (isActive) {
      onSort!(column.sortKey, sortOrder === "asc" ? "desc" : "asc");
    } else {
      onSort!(column.sortKey, "desc");
    }
  };

  const SortIcon = () => {
    if (!isSortable) return null;
    if (!isActive) return <ArrowsDownUp className={SORT_ICON_INACTIVE_CLASS} />;
    return sortOrder === "asc" ? (
      <CaretUp className={SORT_ICON_ACTIVE_CLASS} />
    ) : (
      <CaretDown className={SORT_ICON_ACTIVE_CLASS} />
    );
  };

  return (
    <AppTableColumnMenu onHide={() => onHideColumn(column.key)}>
      <TableHead
        ref={setNodeRef}
        style={style}
        className={cn(
          "h-auto select-none whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground",
          isSortable && "cursor-pointer hover:text-foreground transition-colors",
          column.headerClassName,
        )}
        onClick={handleSortClick}
      >
        <div className="flex items-center gap-1">
          <span
            {...attributes}
            {...listeners}
            onClick={(e) => e.stopPropagation()}
            className={DRAG_HANDLE_CLASS}
            suppressHydrationWarning
          >
            <DotsSixVertical className="h-3.5 w-3.5" />
          </span>

          {column.header}

          <SortIcon />

          {column.headerTooltip && (
            <Tooltip>
              <TooltipTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Info className="h-3 w-3 text-muted-foreground/60 hover:text-muted-foreground cursor-pointer" />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs text-xs">
                {column.headerTooltip}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TableHead>
    </AppTableColumnMenu>
  );
}

// ─── AppTableHeader ─────────────────────────────────────────────────────────

interface AppTableHeaderProps<TRow> {
  columns: AppTableColumn<TRow>[];
  columnOrder: string[];
  sortBy?: string;
  sortOrder?: AppTableSortDirection;
  onSort?: (col: string, dir: AppTableSortDirection) => void;
  stickyHeader?: boolean;
  onHideColumn: (key: string) => void;
}

export function AppTableHeader<TRow>({
  columns,
  columnOrder,
  sortBy,
  sortOrder,
  onSort,
  stickyHeader,
  onHideColumn,
}: AppTableHeaderProps<TRow>) {
  const orderedColumns = columnOrder
    .map((key) => columns.find((c) => c.key === key))
    .filter(Boolean) as AppTableColumn<TRow>[];

  return (
    <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
      <TableHeader>
        <TableRow className={cn(HEADER_ROW_CLASS, stickyHeader && "sticky top-0 z-10")}>
          {orderedColumns.map((column) => (
            <SortableHeaderCell
              key={column.key}
              column={column}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSort={onSort}
              stickyHeader={stickyHeader}
              onHideColumn={onHideColumn}
            />
          ))}
        </TableRow>
      </TableHeader>
    </SortableContext>
  );
}

import type { ReactNode } from "react";
import { TableCell, TableRow } from "@/shadcn/ui/table";
import { DEFAULT_EMPTY_TITLE } from "./utils";

interface AppTableEmptyProps {
  colCount: number;
  emptyState?: ReactNode;
}

export function AppTableEmpty({ colCount, emptyState }: AppTableEmptyProps) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colCount} className="py-10 text-center text-sm text-muted-foreground">
        {emptyState ?? DEFAULT_EMPTY_TITLE}
      </TableCell>
    </TableRow>
  );
}

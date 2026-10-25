import type * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import Utilities from "@/utils";

// DEV_NOTE: A paged list's footer: "1–25 of 214" and Previous / Next; nothing when everything fits on one page
export function Pager({ page, pageSize, totalRecords, onPage }: Schemas.DashboardPagerProps) {
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-caption text-muted-foreground">
        {Utilities.formatCount((page - 1) * pageSize + 1)}–
        {Utilities.formatCount(Math.min(page * pageSize, totalRecords))} of{" "}
        {Utilities.formatCount(totalRecords)}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

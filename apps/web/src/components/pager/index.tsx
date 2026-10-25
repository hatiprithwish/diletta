import type * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import Utilities from "@/utils";

// DEV_NOTE: A paged list's footer: "1–25 of 214" and Previous / Next; nothing when everything fits on one page. With no
// count (loading or failed) it shows "Page N" and keeps Next while this page is full, so more pages stay reachable.
export function Pager({
  page,
  pageSize,
  totalRecords,
  rowCount,
  onPage,
}: Schemas.DashboardPagerProps) {
  if (totalRecords === null) {
    const hasNext = rowCount === pageSize;
    if (page <= 1 && !hasNext) return null;
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption text-muted-foreground">Page {Utilities.formatCount(page)}</p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Previous
          </Button>
          <Button variant="outline" disabled={!hasNext} onClick={() => onPage(page + 1)}>
            Next
          </Button>
        </div>
      </div>
    );
  }
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));
  if (pageCount <= 1 && page <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-caption text-muted-foreground">
        {page > pageCount ? (
          <>{Utilities.formatCount(totalRecords)} in all</>
        ) : (
          <>
            {Utilities.formatCount((page - 1) * pageSize + 1)}–
            {Utilities.formatCount(Math.min(page * pageSize, totalRecords))} of{" "}
            {Utilities.formatCount(totalRecords)}
          </>
        )}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={page <= 1}
          onClick={() => onPage(Math.min(page - 1, pageCount))}
        >
          Previous
        </Button>
        <Button variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

// DEV_NOTE: The body of an empty page past the end: says so and goes back to the last page (or the first, with no count)
export function PastEndNote({ pageSize, totalRecords, onPage }: Schemas.DashboardPastEndNoteProps) {
  const lastPage = totalRecords === null ? 1 : Math.max(1, Math.ceil(totalRecords / pageSize));
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-body text-muted-foreground">Nothing on this page.</p>
      <Button variant="outline" onClick={() => onPage(lastPage)}>
        {lastPage > 1 ? "Go to the last page" : "Back to the first page"}
      </Button>
    </div>
  );
}

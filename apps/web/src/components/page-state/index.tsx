import type * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Skeleton } from "@app/ui/components/skeleton";

// DEV_NOTE: A page body's first load: the metric strip and two boxes as placeholders
export function PageLoading() {
  return (
    <div className="flex flex-col gap-9" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-28 rounded-xl" />
      <div className="grid gap-9 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

// DEV_NOTE: A page body that failed to load: what didn't load and a retry (DESIGN.md §8 copy)
export function PageError({ title, onRetry }: Schemas.DashboardPageErrorProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl bg-destructive-soft px-[22px] py-5"
    >
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium text-foreground">{title}</p>
        <p className="text-caption text-subtle-foreground">Check your connection and try again.</p>
      </div>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

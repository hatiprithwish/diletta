import type { PropsWithChildren } from "react";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: Every dashboard page opens with this (DESIGN.md §4): h1 + one-line description, actions (children)
// right-aligned
export function PageHeader({
  title,
  description,
  children,
}: PropsWithChildren<Schemas.DashboardPageHeaderProps>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-page-title text-foreground">{title}</h1>
        <p className="text-body text-muted-foreground">{description}</p>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

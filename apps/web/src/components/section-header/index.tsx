import type { PropsWithChildren } from "react";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: A page section's header: h2 + optional one-line description, its action (children) right-aligned
export function SectionHeader({
  title,
  description,
  children,
}: PropsWithChildren<Schemas.DashboardSectionProps>) {
  return (
    <div className="flex min-h-9 items-end justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-section text-foreground">{title}</h2>
        {description && <p className="text-caption text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

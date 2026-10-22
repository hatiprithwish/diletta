import type { PropsWithChildren } from "react";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: A full-screen message in place of the shell (No access, load failure); actions come in as children
export function ShellMessage({
  title,
  description,
  children,
}: PropsWithChildren<Schemas.DashboardShellMessageProps>) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-section text-foreground">{title}</h1>
        <p className="text-body text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

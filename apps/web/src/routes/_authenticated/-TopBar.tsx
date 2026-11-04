import { Fragment } from "react";
import { ArrowBendUpLeft, Moon, SidebarSimple, Sun } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import { Badge } from "@app/ui/components/badge";
import { Separator } from "@app/ui/components/separator";
import { useSidebar } from "@app/ui/components/sidebar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@app/ui/components/breadcrumb";
import * as Schemas from "@app/schemas";
import { StatusChip } from "@/components/status-chip";
import { useTheme } from "@/providers/ThemeProvider";

// DEV_NOTE: Set at build time (deploy workflows); local dev runs against the staging branch, so unset = Staging
const ENVIRONMENT_LABEL = import.meta.env.VITE_APP_ENV === "production" ? "Production" : "Staging";

// DEV_NOTE: ADR 0006 / M7-8. An operator acting in a company sees which one, and Back to operator (that company's
// operator page)
export function TopBar({ crumbs, actingCompany, onBackToOperator }: Schemas.DashboardTopBarProps) {
  const { toggleSidebar } = useSidebar();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-subtle-foreground"
        onClick={toggleSidebar}
        aria-label="Toggle sidebar"
      >
        <SidebarSimple />
      </Button>
      <Separator orientation="vertical" className="data-vertical:h-4 data-vertical:self-center" />
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((crumb, index) => (
            <Fragment key={crumb}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {index === crumbs.length - 1 ? (
                  <BreadcrumbPage className="text-body">{crumb}</BreadcrumbPage>
                ) : (
                  <span className="text-body text-muted-foreground">{crumb}</span>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        {actingCompany !== null && (
          <>
            <span className="max-w-56 truncate">
              <StatusChip
                label={`Acting as ${actingCompany.name}`}
                tone={Schemas.DashboardChipToneEnum.Warning}
              />
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-subtle-foreground"
              onClick={onBackToOperator}
            >
              <ArrowBendUpLeft aria-hidden />
              Back to operator
            </Button>
          </>
        )}
        <Badge className="gap-1.5 bg-brand-soft text-brand-text">
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {ENVIRONMENT_LABEL}
        </Badge>
        <Button
          variant="outline"
          size="icon"
          className="text-subtle-foreground"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        >
          {isDark ? <Sun /> : <Moon />}
        </Button>
      </div>
    </header>
  );
}

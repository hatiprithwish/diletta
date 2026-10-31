import { Fragment } from "react";
import { useLocation } from "@tanstack/react-router";
import { Moon, SidebarSimple, Sun } from "@phosphor-icons/react";
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
import { useTheme } from "@/providers/ThemeProvider";
import { getBreadcrumbs } from "./-nav";

// DEV_NOTE: Set at build time (deploy workflows); local dev runs against the staging branch, so unset = Staging
const ENVIRONMENT_LABEL = import.meta.env.VITE_APP_ENV === "production" ? "Production" : "Staging";

export function TopBar() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { toggleSidebar } = useSidebar();
  const { resolvedTheme, setTheme } = useTheme();
  const crumbs = getBreadcrumbs(pathname);
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

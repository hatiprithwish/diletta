import { Link, useLocation } from "@tanstack/react-router";
import { ChatCircle } from "@phosphor-icons/react";
import type * as Schemas from "@app/schemas";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@app/ui/components/sidebar";
import { AccountMenu } from "./-AppSidebar";
import { OPERATOR_NAV_GROUPS, isPathActive } from "./-nav";

// DEV_NOTE: M7-8. The operator pages' sidebar: the same shell as a company's (DESIGN.md §4), with Diletta operator in
// place of the company and the operator nav. Opening a company's dashboard swaps in that company's sidebar.
export function OperatorSidebar({ admin }: Schemas.DashboardOperatorSidebarProps) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { setOpenMobile } = useSidebar();

  // DEV_NOTE: On mobile the sidebar is a Sheet, which shadcn doesn't close on navigation
  const closeMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 justify-center">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent">
              <Link to="/operator/companies" onClick={closeMobile}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <ChatCircle weight="bold" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-body font-semibold">Companion</span>
                  <span className="truncate text-caption text-muted-foreground">
                    Diletta operator
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {OPERATOR_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={isPathActive(pathname, item.to)}
                    tooltip={item.label}
                    className="text-subtle-foreground"
                  >
                    <Link to={item.to} onClick={closeMobile}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <AccountMenu admin={admin} />
      </SidebarFooter>
    </Sidebar>
  );
}

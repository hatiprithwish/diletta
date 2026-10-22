import { useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useClerk } from "@clerk/tanstack-react-start";
import { CaretRight, CaretUpDown, ChatCircle, SignOut } from "@phosphor-icons/react";
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "@app/ui/components/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@app/ui/components/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@app/ui/components/dropdown-menu";
import { Avatar, AvatarFallback } from "@app/ui/components/avatar";
import Utilities from "@/utils";
import { NAV_GROUPS, getActiveNestedTo, isPathActive } from "./-nav";

export function AppSidebar({ admin }: Schemas.DashboardSidebarProps) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isRail = state === "collapsed" && !isMobile;
  const activeNestedTo = getActiveNestedTo(pathname);
  const [openNested, setOpenNested] = useState<Record<string, boolean>>(() =>
    activeNestedTo ? { [activeNestedTo]: true } : {},
  );
  const [prevActiveNestedTo, setPrevActiveNestedTo] = useState(activeNestedTo);

  // Opens a nested group when navigation lands on one of its pages (state adjusted during render, no effect)
  if (activeNestedTo !== prevActiveNestedTo) {
    setPrevActiveNestedTo(activeNestedTo);
    if (activeNestedTo) setOpenNested((open) => ({ ...open, [activeNestedTo]: true }));
  }

  // DEV_NOTE: On mobile the sidebar is a Sheet, which shadcn doesn't close on navigation
  const closeMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 justify-center">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent">
              <Link to="/overview" onClick={closeMobile}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <ChatCircle weight="bold" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-body font-semibold">Companion</span>
                  <span className="truncate text-caption text-muted-foreground">
                    {admin.company?.name}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group, index) => (
          <SidebarGroup key={group.label}>
            {index > 0 && (
              <SidebarSeparator className="mx-auto mb-2 hidden w-4 group-data-[collapsible=icon]:block" />
            )}
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const isActive = isPathActive(pathname, item.to);

                // A plain page, or a nested group in the icon rail (its sub-items are hidden there, so the icon
                // links straight to the group's first page)
                if (!("items" in item) || isRail) {
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.label}
                        className="text-subtle-foreground"
                      >
                        <Link
                          to={"items" in item ? item.items[0].to : item.to}
                          onClick={closeMobile}
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                }

                return (
                  <Collapsible
                    key={item.to}
                    asChild
                    open={openNested[item.to] ?? false}
                    onOpenChange={(open) =>
                      setOpenNested((current) => ({ ...current, [item.to]: open }))
                    }
                    className="group/collapsible"
                  >
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton className="text-subtle-foreground">
                          <item.icon />
                          <span>{item.label}</span>
                          <CaretRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {item.items.map((subItem) => (
                            <SidebarMenuSubItem key={subItem.to}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={isPathActive(pathname, subItem.to)}
                                className="text-subtle-foreground"
                              >
                                <Link to={subItem.to} onClick={closeMobile}>
                                  <span>{subItem.label}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              })}
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

function AccountMenu({ admin }: Schemas.DashboardSidebarProps) {
  const { signOut } = useClerk();
  const displayName = admin.name ?? admin.email ?? "Account";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-accent text-caption text-subtle-foreground">
                  {Utilities.getInitials(displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-body font-medium">{displayName}</span>
                {admin.email && (
                  <span className="truncate text-caption text-muted-foreground">{admin.email}</span>
                )}
              </div>
              <CaretUpDown className="ml-auto text-subtle-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-56">
            <DropdownMenuLabel className="grid leading-tight">
              <span className="truncate text-body font-medium">{displayName}</span>
              {admin.email && (
                <span className="truncate text-caption font-normal text-muted-foreground">
                  {admin.email}
                </span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut({ redirectUrl: "/auth/sign-in" })}>
              <SignOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

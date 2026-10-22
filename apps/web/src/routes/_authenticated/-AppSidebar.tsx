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
import { NAV_GROUPS, SETTINGS_NAV, isPathActive } from "./-nav";

export function AppSidebar({ admin }: Schemas.DashboardSidebarProps) {
  const pathname = useLocation({ select: (location) => location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 justify-center">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild className="hover:bg-transparent">
              <Link to="/overview">
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
              {group.items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={isPathActive(pathname, item.to)}
                    tooltip={item.label}
                    className="text-subtle-foreground"
                  >
                    <Link to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {group.label === "Admin" && <SettingsNavItem pathname={pathname} />}
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

// DEV_NOTE: Settings is a Collapsible, open while a settings page is active. In the icon rail the sub-items are
// hidden, so the gear links straight to the first settings page instead.
function SettingsNavItem({ pathname }: Schemas.DashboardSettingsNavProps) {
  const { state, isMobile } = useSidebar();
  const isSettingsActive = isPathActive(pathname, SETTINGS_NAV.to);
  const [isOpen, setIsOpen] = useState(isSettingsActive);
  const [wasSettingsActive, setWasSettingsActive] = useState(isSettingsActive);

  // Opens the group when navigation lands on a settings page (state adjusted during render, no effect)
  if (isSettingsActive !== wasSettingsActive) {
    setWasSettingsActive(isSettingsActive);
    if (isSettingsActive) setIsOpen(true);
  }

  if (state === "collapsed" && !isMobile) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          isActive={isSettingsActive}
          tooltip={SETTINGS_NAV.label}
          className="text-subtle-foreground"
        >
          <Link to={SETTINGS_NAV.items[0].to}>
            <SETTINGS_NAV.icon />
            <span>{SETTINGS_NAV.label}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <Collapsible asChild open={isOpen} onOpenChange={setIsOpen} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton className="text-subtle-foreground">
            <SETTINGS_NAV.icon />
            <span>{SETTINGS_NAV.label}</span>
            <CaretRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {SETTINGS_NAV.items.map((item) => (
              <SidebarMenuSubItem key={item.to}>
                <SidebarMenuSubButton
                  asChild
                  isActive={isPathActive(pathname, item.to)}
                  className="text-subtle-foreground"
                >
                  <Link to={item.to}>
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
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

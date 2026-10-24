import {
  BookOpen,
  ChartBar,
  ChatCircle,
  Clock,
  Flag,
  Flask,
  Gear,
  GitDiff,
  ShieldCheck,
  SquaresFour,
} from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The dashboard's navigation (DESIGN.md §4), the only place it is defined: the sidebar and the breadcrumb
// just map it. An item with `items` is a nested group (Settings): a Collapsible whose pages sit under its `to`.
// Everything is company-level: no chatbot in any path (§6). An item with `badge` shows that count (§4: the sidebar
// fills it).
export const NAV_GROUPS = [
  {
    label: "Monitor",
    items: [
      { label: "Overview", to: "/overview", icon: SquaresFour },
      { label: "Conversations", to: "/conversations", icon: ChatCircle },
      {
        label: "Changes",
        to: "/changes",
        icon: GitDiff,
        badge: Schemas.DashboardNavBadgeEnum.ChangesNeedsHuman,
      },
      {
        label: "Quality",
        to: "/quality",
        icon: Flag,
        badge: Schemas.DashboardNavBadgeEnum.QualityOpen,
      },
    ],
  },
  {
    label: "Improve",
    items: [
      { label: "Tests", to: "/tests", icon: Flask },
      { label: "Knowledge", to: "/knowledge", icon: BookOpen },
    ],
  },
  {
    label: "Insights",
    items: [
      { label: "Impact", to: "/impact", icon: Clock },
      { label: "Usage", to: "/usage", icon: ChartBar },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Security", to: "/security", icon: ShieldCheck },
      {
        label: "Settings",
        to: "/settings",
        icon: Gear,
        items: [
          { label: "Bots", to: "/settings/bots" },
          { label: "Model keys", to: "/settings/model-keys" },
          { label: "Connections", to: "/settings/connections" },
          { label: "Team", to: "/settings/team" },
          { label: "Budget", to: "/settings/budget" },
        ],
      },
    ],
  },
] as const;

export function isPathActive(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

// The nested group holding the current page, if any (the sidebar opens it)
export function getActiveNestedTo(pathname: string): string | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if ("items" in item && isPathActive(pathname, item.to)) return item.to;
    }
  }
  return null;
}

// DEV_NOTE: Breadcrumb trail for a path: one crumb for a top-level page, <group> › <page> inside a nested group.
export function getBreadcrumbs(pathname: string) {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (!isPathActive(pathname, item.to)) continue;
      if (!("items" in item)) return [item.label];
      const child = item.items.find((subItem) => isPathActive(pathname, subItem.to));
      return child ? [item.label, child.label] : [item.label];
    }
  }
  return [];
}

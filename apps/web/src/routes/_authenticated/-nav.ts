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

// DEV_NOTE: The dashboard's navigation (DESIGN.md §4), read by the sidebar and the breadcrumb. Settings is the one
// nested group; its pages sit under /settings/*. Everything is company-level: no chatbot in any path (§6).
export const NAV_GROUPS = [
  {
    label: "Monitor",
    items: [
      { label: "Overview", to: "/overview", icon: SquaresFour },
      { label: "Conversations", to: "/conversations", icon: ChatCircle },
      { label: "Changes", to: "/changes", icon: GitDiff },
      { label: "Quality", to: "/quality", icon: Flag },
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
    items: [{ label: "Security", to: "/security", icon: ShieldCheck }],
  },
] as const;

export const SETTINGS_NAV = {
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
} as const;

export function isPathActive(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

// DEV_NOTE: Breadcrumb trail for a path: one crumb for a top-level page, Settings › <page> under /settings.
export function getBreadcrumbs(pathname: string) {
  const settingsPage = SETTINGS_NAV.items.find((item) => isPathActive(pathname, item.to));
  if (settingsPage) return [SETTINGS_NAV.label, settingsPage.label];

  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isPathActive(pathname, item.to)) return [item.label];
    }
  }
  return [];
}

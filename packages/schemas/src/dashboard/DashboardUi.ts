import type { AdminProfile } from "../admins";

// DEV_NOTE: Props of the dashboard shell (apps/web, M4-1). The header's actions come in as children.

export interface DashboardPageHeaderProps {
  title: string;
  description: string;
}

export interface DashboardSidebarProps {
  admin: AdminProfile;
}

export interface DashboardShellMessageProps {
  title: string;
  description: string;
}

import type { AdminProfile } from "../admins";
import type {
  ImpactRangeEnum,
  InsightsImpact,
  InsightsImpactTask,
  InsightsOverview,
  InsightsUsage,
} from "../insights";

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

// DEV_NOTE: Shared page pieces (M4-3, DESIGN.md §5): the metric strip, the range select, the bar chart and a page's
// load / error states. Actions and bodies come in as children.

// The colour of a note under a metric: positive (success), negative (warning), neutral (muted)
export enum DashboardToneEnum {
  Neutral = "neutral",
  Positive = "positive",
  Negative = "negative",
}

export interface DashboardMetricCellProps {
  label: string;
  value: string;
  note?: string;
  noteTone?: DashboardToneEnum;
}

export interface DashboardSelectOption {
  value: string;
  label: string;
}

export interface DashboardRangeSelectProps {
  value: string;
  options: DashboardSelectOption[];
  onValueChange: (value: string) => void;
}

// DEV_NOTE: One bar. label is the axis text (a day or a week), valueLabel the formatted value its tooltip shows
export interface DashboardBarDatum {
  key: string;
  label: string;
  value: number;
  valueLabel: string;
}

export interface DashboardBarChartProps {
  data: DashboardBarDatum[];
  ariaLabel: string;
}

export interface DashboardSectionProps {
  title: string;
  description?: string;
}

export interface DashboardPageErrorProps {
  title: string;
  onRetry: () => void;
}

// DEV_NOTE: The Insights pages' sections (M4-3) each take their page's whole response
export interface DashboardOverviewSectionProps {
  overview: InsightsOverview;
}

export interface DashboardUsageSectionProps {
  usage: InsightsUsage;
}

export interface DashboardImpactSectionProps {
  impact: InsightsImpact;
}

// Impact's metric strip names its range ("this month") and what it is compared with
export interface DashboardImpactMetricsProps extends DashboardImpactSectionProps {
  range: ImpactRangeEnum;
}

// One line of Overview's needs attention: a link to the page that resolves it; its icon comes in as children
export interface DashboardAttentionRowProps {
  to: "/changes" | "/quality" | "/knowledge";
  label: string;
  detail?: string;
}

// Impact's minutes per task editor (a dialog per task)
export interface DashboardRoiEditProps {
  task: InsightsImpactTask;
}

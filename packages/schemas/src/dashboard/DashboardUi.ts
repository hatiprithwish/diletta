import type { AdminProfile } from "../admins";
import type {
  ChangeRequestDetail,
  ChangeRequestListTabEnum,
  ChangeRequestListItem,
  ChangeRequestTimelineEntry,
  ChangesPageSearch,
  GetChangeRequestsApiResponse,
} from "../changeRequests";
import type {
  ConversationDetail,
  ConversationListItem,
  ConversationTurn,
  ConversationTurnMessage,
  ConversationTurnToolCall,
  ConversationsPageSearch,
  GetConversationsApiResponse,
} from "../conversations";
import type {
  DocGapClusterListItem,
  DocGapClusterListTabEnum,
  KnowledgePageSearch,
} from "../docGapClusters";
import type { FeedbackRatingIntEnum } from "../feedback";
import type {
  GetKnowledgeDocumentsApiResponse,
  KnowledgeDocumentWithStatus,
} from "../knowledgeDocuments";
import type {
  KnowledgeSourcePageSearch,
  KnowledgeSourceTypeIntEnum,
  KnowledgeSourceWithStatus,
} from "../knowledgeSources";
import type {
  GetQualityIssuesApiResponse,
  QualityIssueDetail,
  QualityIssueListItem,
  QualityPageSearch,
  QualityTestDraft,
} from "../qualityIssues";
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
// DEV_NOTE: changesTab (M4-5) opens the Changes page on that tab
export interface DashboardAttentionRowProps {
  to: "/changes" | "/quality" | "/knowledge";
  label: string;
  detail?: string;
  changesTab?: ChangeRequestListTabEnum;
}

// Impact's minutes per task editor (a dialog per task)
export interface DashboardRoiEditProps {
  task: InsightsImpactTask;
}

// DEV_NOTE: A status chip (DESIGN.md §5): a Badge with a 6px dot in the text colour, one tone per meaning
export enum DashboardChipToneEnum {
  Neutral = "neutral",
  Success = "success",
  Warning = "warning",
  Destructive = "destructive",
  Brand = "brand",
}

export interface DashboardStatusChipProps {
  label: string;
  tone: DashboardChipToneEnum;
}

// DEV_NOTE: A dropdown filter (DESIGN.md §5): its label muted, the value in foreground
export interface DashboardFilterSelectProps extends DashboardRangeSelectProps {
  label: string;
}

// DEV_NOTE: The Conversations page (M4-4): the list, and the detail card of selectedId next to it (null = none)
export interface DashboardConversationsPageProps {
  search: ConversationsPageSearch;
  selectedId: string | null;
}

// DEV_NOTE: The list under the filters: its rows, an empty state (clearing the filters when some are set) and Previous /
// Next pages
export interface DashboardConversationListProps {
  response: GetConversationsApiResponse;
  search: ConversationsPageSearch;
  selectedId: string | null;
  hasFilters: boolean;
  onClearFilters: () => void;
  onPage: (page: number) => void;
}

export interface DashboardConversationRowProps {
  conversation: ConversationListItem;
  search: ConversationsPageSearch;
  isSelected: boolean;
}

export interface DashboardConversationDetailProps {
  publicId: string;
  search: ConversationsPageSearch;
}

// One loaded conversation: the detail card's summary line and body
export interface DashboardConversationProps {
  conversation: ConversationDetail;
}

export interface DashboardConversationTurnProps {
  conversation: ConversationDetail;
  turn: ConversationTurn;
}

// DEV_NOTE: One message of a turn; speaker is the user's first name (or "User") or "Assistant"
export interface DashboardConversationMessageProps {
  message: ConversationTurnMessage;
  speaker: string;
}

// A thumb (up, down) or a dash when there is none
export interface DashboardRatingIconProps {
  rating: FeedbackRatingIntEnum | null;
}

export interface DashboardConversationToolRowProps {
  toolCall: ConversationTurnToolCall;
}

// DEV_NOTE: The Changes page (M4-5): the list, and the detail card of selectedId next to it (null = none)
export interface DashboardChangesPageProps {
  search: ChangesPageSearch;
  selectedId: string | null;
}

// DEV_NOTE: The list under the filters: its rows, an empty state (clearing the filters when some are set) and Previous /
// Next pages
export interface DashboardChangeListProps {
  response: GetChangeRequestsApiResponse;
  search: ChangesPageSearch;
  selectedId: string | null;
  hasFilters: boolean;
  onClearFilters: () => void;
  onPage: (page: number) => void;
}

// DEV_NOTE: The filtered-empty state, with Clear filters
export interface DashboardNoMatchesProps {
  onClearFilters: () => void;
}

export interface DashboardChangeRowProps {
  changeRequest: ChangeRequestListItem;
  search: ChangesPageSearch;
  isSelected: boolean;
}

export interface DashboardChangeDetailCardProps {
  publicId: string;
  search: ChangesPageSearch;
}

// DEV_NOTE: One loaded change's body (M4-4; M4-5 adds its timeline and Mark resolved)
export interface DashboardChangeDetailProps {
  changeRequest: ChangeRequestDetail;
}

export interface DashboardChangeTimelineProps {
  timeline: ChangeRequestTimelineEntry[];
}

// DEV_NOTE: The Quality page (M4-6): the inbox list, and the detail card of selectedId next to it (null = none)
export interface DashboardQualityPageProps {
  search: QualityPageSearch;
  selectedId: string | null;
}

// DEV_NOTE: The list under the tabs: its rows, an empty state per tab and Previous / Next pages
export interface DashboardQualityListProps {
  response: GetQualityIssuesApiResponse;
  search: QualityPageSearch;
  selectedId: string | null;
  onPage: (page: number) => void;
}

export interface DashboardQualityRowProps {
  qualityIssue: QualityIssueListItem;
  search: QualityPageSearch;
  isSelected: boolean;
}

export interface DashboardQualityDetailCardProps {
  publicId: string;
  search: QualityPageSearch;
}

// DEV_NOTE: One loaded issue's body, and its triage (type + note, editable while Open)
export interface DashboardQualityDetailProps {
  qualityIssue: QualityIssueDetail;
}

// DEV_NOTE: Create test's review: the draft to edit and save (null = closed)
export interface DashboardQualityTestDialogProps {
  publicId: string;
  draft: QualityTestDraft | null;
  onClose: () => void;
}

// DEV_NOTE: The Knowledge page (M4-7): the sources table, a banner per failed source, and the groups of questions the
// assistant couldn't answer. Tab and pages live in the URL.
export interface DashboardKnowledgePageProps {
  search: KnowledgePageSearch;
}

// DEV_NOTE: onAddSource opens Add source, with the type picked when given (the groups' "Add an upload source")
export interface DashboardKnowledgeSourcesProps {
  page: number;
  onPage: (page: number) => void;
  onAddSource: (type?: KnowledgeSourceTypeIntEnum) => void;
}

// DEV_NOTE: A source's actions: the row menu on the Sources table, the buttons on the source's page (isOnSourcePage;
// a deleted source then leaves to /knowledge)
export interface DashboardKnowledgeSourceActionsProps {
  source: KnowledgeSourceWithStatus;
  isOnSourcePage: boolean;
}

export interface DashboardKnowledgeSourceProps {
  source: KnowledgeSourceWithStatus;
}

// DEV_NOTE: Add source; initialType preselects the type (null = closed)
export interface DashboardKnowledgeAddSourceDialogProps {
  initialType: KnowledgeSourceTypeIntEnum | null;
  onClose: () => void;
}

export interface DashboardKnowledgeEditSourceDialogProps {
  source: KnowledgeSourceWithStatus;
  isOpen: boolean;
  onClose: () => void;
}

// DEV_NOTE: The groups under their tabs; onSearch keeps the rest of the URL search
export interface DashboardDocGapClustersProps {
  tab: DocGapClusterListTabEnum;
  page: number;
  onSearch: (next: Pick<KnowledgePageSearch, "tab" | "page">) => void;
  onAddUploadSource: () => void;
}

// DEV_NOTE: isDismissing = this row's Dismiss is running (the list holds the one mutation)
export interface DashboardDocGapClusterRowProps {
  cluster: DocGapClusterListItem;
  isDismissing: boolean;
  onAddDocument: (cluster: DocGapClusterListItem) => void;
  onDismiss: (cluster: DocGapClusterListItem) => void;
}

// DEV_NOTE: "Add a document" for one group: upload a file or pick a document, then the group is answered by it (null =
// closed). onAddUploadSource closes it and opens Add source on Upload.
export interface DashboardDocGapAnswerDialogProps {
  cluster: DocGapClusterListItem | null;
  onClose: () => void;
  onAddUploadSource: () => void;
}

// DEV_NOTE: One source's page (/knowledge/$id): its state, actions and documents
export interface DashboardKnowledgeSourcePageProps {
  publicId: string;
  search: KnowledgeSourcePageSearch;
}

// DEV_NOTE: The source's documents: page and title filter from the URL (onSearch keeps the rest of it); documentId =
// the row to highlight
export interface DashboardKnowledgeDocumentsProps {
  source: KnowledgeSourceWithStatus;
  search: KnowledgeSourcePageSearch;
  onSearch: (next: KnowledgeSourcePageSearch) => void;
}

export interface DashboardKnowledgeDocumentRowProps {
  source: KnowledgeSourceWithStatus;
  document: KnowledgeDocumentWithStatus;
  isHighlighted: boolean;
}

// DEV_NOTE: How "Add a document" brings the document: a new upload, or one picked from a source
export enum DashboardDocGapAnswerModeEnum {
  Upload = "upload",
  Pick = "pick",
}

// DEV_NOTE: The file "Add a document" already uploaded (and the document it became), reused when the answer is retried
export interface DashboardUploadedAnswerDocument {
  file: File;
  sourcePublicId: string;
  documentPublicId: string;
}

// DEV_NOTE: The picker's matching documents as a radio list (selectedId "" = none yet). The query asks for one more
// than it shows, so hasMore says whether to ask for a longer title.
export interface DashboardDocumentChoicesProps {
  response: GetKnowledgeDocumentsApiResponse | undefined;
  isPending: boolean;
  isError: boolean;
  selectedId: string;
  onSelect: (documentPublicId: string) => void;
}

// DEV_NOTE: A source's name input in Add source and Edit (errors from the form field's validator)
export interface DashboardKnowledgeNameFieldProps {
  id: string;
  name: string;
  value: string;
  errors: string[];
  onBlur: () => void;
  onChange: (value: string) => void;
}

// DEV_NOTE: A website's re-sync choice, the frequency's int as a string (the Select's value)
export interface DashboardKnowledgeFrequencySelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

// DEV_NOTE: Previous / Next under a paged list, with "1–25 of 214"
export interface DashboardPagerProps {
  page: number;
  pageSize: number;
  totalRecords: number;
  onPage: (page: number) => void;
}

// DEV_NOTE: A sidebar item's count badge (DESIGN.md §4), named in -nav.ts and filled by the sidebar: Changes (needs a
// person, destructive) and Quality (open issues, warning, M4-6).
export enum DashboardNavBadgeEnum {
  ChangesNeedsHuman = "changes_needs_human",
  QualityOpen = "quality_open",
}

// DEV_NOTE: isRail = the sidebar is the icon rail, where the count becomes a 6px dot
export interface DashboardNavBadgeProps {
  badge: DashboardNavBadgeEnum;
  isRail: boolean;
}

// DEV_NOTE: One badge's own count (each badge reads only its own query)
export interface DashboardNavBadgeSourceProps {
  isRail: boolean;
}

// DEV_NOTE: How a count badge looks: its count, what it counts (aria label) and its tone (DESIGN.md §4: destructive for
// Changes, warning for Quality)
export interface DashboardNavCountProps {
  count: number;
  label: string;
  tone: DashboardChipToneEnum.Destructive | DashboardChipToneEnum.Warning;
  isRail: boolean;
}

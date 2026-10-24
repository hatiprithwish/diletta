import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Card } from "@app/ui/components/card";
import { Skeleton } from "@app/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@app/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@app/ui/components/toggle-group";
import { cn } from "@app/ui/lib/utils";
import { FilterSelect } from "@/components/filter-select";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { StatusChip } from "@/components/status-chip";
import { ApiError } from "@/providers/apiClient";
import Utilities from "@/utils";
import { useChange, useChangeRequesters, useChanges, useResolveChange } from "./-data";

const HEAD_CLASS = "h-auto px-4 py-3 text-caption font-normal text-muted-foreground";
const CELL_CLASS = "px-4 py-[13px] text-body";
// DEV_NOTE: Radix Select can't hold an empty value, so "no filter" is its own option
const ANYONE = "anyone";
const UNNAMED_USER = "Unnamed user";

const TABS: { value: Schemas.ChangeRequestListTabEnum; label: string }[] = [
  { value: Schemas.ChangeRequestListTabEnum.All, label: "All" },
  { value: Schemas.ChangeRequestListTabEnum.Waiting, label: "Waiting" },
  { value: Schemas.ChangeRequestListTabEnum.Verified, label: "Verified" },
  { value: Schemas.ChangeRequestListTabEnum.Undone, label: "Undone" },
  { value: Schemas.ChangeRequestListTabEnum.NeedsHuman, label: "Needs a person" },
];

const DOT_CLASS: Record<Schemas.ChangeRequestTimelineToneEnum, string> = {
  [Schemas.ChangeRequestTimelineToneEnum.Neutral]: "bg-subtle-foreground",
  [Schemas.ChangeRequestTimelineToneEnum.Success]: "bg-success",
  [Schemas.ChangeRequestTimelineToneEnum.Destructive]: "bg-destructive",
};

function ToolName({
  toolName,
  toolVersion,
}: Pick<Schemas.ChangeRequestListItem, "toolName" | "toolVersion">) {
  return (
    <span className="font-mono text-mono-value text-muted-foreground">
      {toolName ?? "Removed tool"} v{toolVersion}
    </span>
  );
}

// DEV_NOTE: The whole page body, shared by /changes and /changes/$id (selectedId). Filters and the page live in the URL;
// a filter change goes back to page 1 and keeps the open change.
export function ChangesPage({ search, selectedId }: Schemas.DashboardChangesPageProps) {
  const navigate = useNavigate();
  const query = useChanges(search);
  const requesters = useChangeRequesters(search.requesterId ?? null);
  const data = query.data;
  // DEV_NOTE: An unknown requester in the URL (a stale link) answers 404: nothing matches, not an outage
  const isUnknownFilter =
    Boolean(search.requesterId) && query.error instanceof ApiError && query.error.status === 404;
  // DEV_NOTE: The previous filter's rows and counts stay up while the next ones load (keepPreviousData): dimmed and
  // marked busy, so they never read as the new tab's
  const isStale = query.isPlaceholderData;
  const tab = search.tab ?? Schemas.ChangeRequestListTabEnum.All;

  const goTo = (next: Schemas.ChangesPageSearch) => {
    const parsed = Schemas.ZChangesPageSearch.parse(next);
    if (selectedId) {
      void navigate({ to: "/changes/$id", params: { id: selectedId }, search: parsed });
    } else {
      void navigate({ to: "/changes", search: parsed });
    }
  };
  const setFilter = (next: Partial<Schemas.ChangesPageSearch>) =>
    goTo({ ...search, ...next, page: undefined });

  const requesterOptions = [
    { value: ANYONE, label: "Anyone" },
    ...(requesters.data?.requesters ?? []).map((requester) => ({
      value: requester.hostUserId,
      label: requester.name ?? UNNAMED_USER,
    })),
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Changes"
        description="Writes the assistant proposed, with approvals and checks"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={tab}
          onValueChange={(value) => {
            const next = Schemas.ZChangeRequestListTab.safeParse(value);
            if (next.success) {
              setFilter({
                tab: next.data === Schemas.ChangeRequestListTabEnum.All ? undefined : next.data,
              });
            }
          }}
          aria-label="Show"
          className="flex-wrap"
        >
          {TABS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} className="gap-1.5 px-3">
              {item.label}
              {data?.tabCounts && (
                <span className={cn("text-muted-foreground", isStale && "opacity-50")}>
                  {Utilities.formatCount(data.tabCounts[item.value])}
                </span>
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FilterSelect
          label="Requested by"
          value={search.requesterId ?? ANYONE}
          options={requesterOptions}
          onValueChange={(value) =>
            setFilter({ requesterId: value === ANYONE ? undefined : value })
          }
        />
      </div>

      <div className="grid items-start gap-6 min-[1100px]:grid-cols-3">
        <div
          className={cn(
            "min-w-0",
            selectedId ? "min-[1100px]:col-span-2" : "min-[1100px]:col-span-3",
          )}
        >
          {query.isPending && <ListLoading />}
          {!query.isPending && !data && isUnknownFilter && (
            <NoMatches onClearFilters={() => goTo({})} />
          )}
          {!query.isPending && !data && !isUnknownFilter && (
            <PageError title="Changes didn't load" onRetry={() => void query.refetch()} />
          )}
          {data && (
            <div
              aria-busy={isStale}
              className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}
            >
              <ChangeList
                response={data}
                search={search}
                selectedId={selectedId}
                hasFilters={Boolean(search.tab || search.requesterId)}
                onClearFilters={() => goTo({})}
                onPage={(page) => goTo({ ...search, page: page === 1 ? undefined : page })}
              />
            </div>
          )}
        </div>
        {selectedId && <ChangeDetailCard publicId={selectedId} search={search} />}
      </div>
    </div>
  );
}

function ListLoading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-11 rounded-md" />
      ))}
    </div>
  );
}

function ChangeList({
  response,
  search,
  selectedId,
  hasFilters,
  onClearFilters,
  onPage,
}: Schemas.DashboardChangeListProps) {
  const changeRequests = response.changeRequests ?? [];
  const totalRecords = response.totalRecords ?? 0;
  const page = search.page ?? 1;
  const pageSize = Schemas.CHANGES_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));

  if (changeRequests.length === 0) {
    if (hasFilters || page > 1) return <NoMatches onClearFilters={onClearFilters} />;
    return (
      <p className="rounded-xl border px-[22px] py-5 text-body text-muted-foreground">
        No changes yet. They show up here once your chatbot proposes a change to your data.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD_CLASS}>Change</TableHead>
              <TableHead className={HEAD_CLASS}>Tool</TableHead>
              <TableHead className={`${HEAD_CLASS} text-right`}>Records</TableHead>
              <TableHead className={HEAD_CLASS}>Status</TableHead>
              <TableHead className={HEAD_CLASS}>Requested by</TableHead>
              <TableHead className={HEAD_CLASS}>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {changeRequests.map((changeRequest) => (
              <ChangeRow
                key={changeRequest.publicId}
                changeRequest={changeRequest}
                search={search}
                isSelected={changeRequest.publicId === selectedId}
              />
            ))}
          </TableBody>
        </Table>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-caption text-muted-foreground">
            {Utilities.formatCount((page - 1) * pageSize + 1)}–
            {Utilities.formatCount(Math.min(page * pageSize, totalRecords))} of{" "}
            {Utilities.formatCount(totalRecords)}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
              Previous
            </Button>
            <Button variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NoMatches({ onClearFilters }: Schemas.DashboardNoMatchesProps) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border px-[22px] py-5">
      <p className="text-body text-muted-foreground">No changes match these filters.</p>
      <Button variant="outline" onClick={onClearFilters}>
        Clear filters
      </Button>
    </div>
  );
}

function ChangeRow({ changeRequest, search, isSelected }: Schemas.DashboardChangeRowProps) {
  const navigate = useNavigate();
  return (
    <TableRow
      className={cn("cursor-pointer", isSelected && "bg-surface-subtle")}
      data-state={isSelected ? "selected" : undefined}
      onClick={() =>
        void navigate({ to: "/changes/$id", params: { id: changeRequest.publicId }, search })
      }
    >
      <TableCell className={CELL_CLASS}>
        <Link
          to="/changes/$id"
          params={{ id: changeRequest.publicId }}
          search={search}
          className="block max-w-[320px] truncate text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          {changeRequest.summary}
        </Link>
      </TableCell>
      <TableCell className={cn(CELL_CLASS, "whitespace-nowrap")}>
        <ToolName toolName={changeRequest.toolName} toolVersion={changeRequest.toolVersion} />
      </TableCell>
      <TableCell className={`${CELL_CLASS} text-right tabular-nums`}>
        {Utilities.formatCount(changeRequest.changeCount)}
      </TableCell>
      <TableCell className={CELL_CLASS}>
        <StatusChip
          label={changeRequest.changeRequestStatusLabel}
          tone={Utilities.changeRequestTone(changeRequest.changeRequestStatus)}
        />
      </TableCell>
      <TableCell className={cn(CELL_CLASS, "whitespace-nowrap")}>
        {changeRequest.requesterName ?? (
          <span className="text-muted-foreground">{UNNAMED_USER}</span>
        )}
      </TableCell>
      <TableCell className={cn(CELL_CLASS, "whitespace-nowrap text-muted-foreground")}>
        {Utilities.formatWhen(changeRequest.createdAt)}
      </TableCell>
    </TableRow>
  );
}

// DEV_NOTE: The detail card (DESIGN.md §6: the third column at ≥1100px, below the list under it)
function ChangeDetailCard({ publicId, search }: Schemas.DashboardChangeDetailCardProps) {
  const query = useChange(publicId);
  const changeRequest = query.data?.changeRequest;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <Card className="relative gap-0 py-0" role="region" aria-label="Change">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-4 right-4 text-subtle-foreground"
        asChild
      >
        <Link to="/changes" search={search} aria-label="Close">
          <X />
        </Link>
      </Button>
      {query.isPending && (
        <div className="flex flex-col gap-3 px-[22px] py-5" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-6 w-32 rounded-md" />
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      )}
      {!query.isPending && !changeRequest && (
        <div className="px-[22px] py-5 pr-14">
          {isNotFound ? (
            <p className="text-body text-muted-foreground">
              This change isn't available. It may have been removed.
            </p>
          ) : (
            <PageError title="The change didn't load" onRetry={() => void query.refetch()} />
          )}
        </div>
      )}
      {changeRequest && <ChangeDetail changeRequest={changeRequest} />}
    </Card>
  );
}

// DEV_NOTE: One change: where it stands and why, what it was (never its values), its timeline and, while it needs a
// person, Mark resolved
export function ChangeDetail({ changeRequest }: Schemas.DashboardChangeDetailProps) {
  const { conversation } = changeRequest;
  const resolve = useResolveChange(changeRequest.publicId);
  const isNeedsHuman =
    changeRequest.changeRequestStatus === Schemas.ChangeRequestStatusIntEnum.NeedsHuman;
  const byLine = [
    conversation.userName ?? UNNAMED_USER,
    Utilities.formatWhenWithTime(changeRequest.createdAt),
  ].join(", ");

  return (
    <>
      <div className="flex flex-col items-start gap-2 px-[22px] pt-5 pr-14 pb-4">
        <StatusChip
          label={changeRequest.changeRequestStatusLabel}
          tone={Utilities.changeRequestTone(changeRequest.changeRequestStatus)}
        />
        <h2 className="text-section break-words text-foreground">{changeRequest.summary}</h2>
        <p className="text-caption text-muted-foreground">{byLine}</p>
        {changeRequest.wasEdited && (
          <p className="text-caption text-muted-foreground">Edited by the user before approval</p>
        )}
      </div>
      {changeRequest.errorLabel && (
        <p className="mx-[22px] mb-4 rounded-lg bg-destructive-soft px-3 py-2.5 text-body text-foreground">
          {changeRequest.errorLabel}.
          {isNeedsHuman && " Check the record in your app, then mark it resolved."}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 border-t px-[22px] py-4 text-body">
        <dt className="text-muted-foreground">Tool</dt>
        <dd>
          <ToolName toolName={changeRequest.toolName} toolVersion={changeRequest.toolVersion} />
        </dd>
        <dt className="text-muted-foreground">Records</dt>
        <dd className="text-foreground">{Utilities.formatCount(changeRequest.changeCount)}</dd>
        <dt className="text-muted-foreground">Last update</dt>
        <dd className="text-foreground">{Utilities.formatWhenWithTime(changeRequest.updatedAt)}</dd>
        {changeRequest.undoUntil !== null &&
          changeRequest.changeRequestStatus === Schemas.ChangeRequestStatusIntEnum.Verified && (
            <>
              <dt className="text-muted-foreground">Undo until</dt>
              <dd className="text-foreground">
                {Utilities.formatWhenWithTime(changeRequest.undoUntil)}
              </dd>
            </>
          )}
      </dl>
      <div className="border-t px-[22px] py-4">
        {changeRequest.timeline.length > 0 ? (
          <ChangeTimeline timeline={changeRequest.timeline} />
        ) : (
          <p className="text-caption text-muted-foreground">No steps recorded yet.</p>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t px-[22px] py-4">
        <p className="text-caption text-muted-foreground">From the conversation</p>
        <p className="text-body break-words text-foreground">
          {conversation.title ?? "Content deleted"}
        </p>
        <p className="text-caption text-muted-foreground">
          {[conversation.userName ?? UNNAMED_USER, conversation.chatbotName]
            .filter((part): part is string => part !== null)
            .join(", ")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 border-t px-[22px] py-4">
        {isNeedsHuman && (
          <Button disabled={resolve.isPending} onClick={() => resolve.mutate()}>
            {resolve.isPending ? "Marking resolved…" : "Mark resolved"}
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link to="/conversations/$id" params={{ id: conversation.publicId }}>
            Open conversation
          </Link>
        </Button>
      </div>
    </>
  );
}

// DEV_NOTE: The change's steps, oldest first (DESIGN.md §5: 8px dots, 1px connector)
function ChangeTimeline({ timeline }: Schemas.DashboardChangeTimelineProps) {
  return (
    <ol className="flex flex-col" aria-label="Timeline">
      {timeline.map((entry, index) => (
        <li
          key={`${entry.createdAt}-${entry.label}`}
          className="relative flex gap-3 pb-3 last:pb-0"
        >
          {index < timeline.length - 1 && (
            <span className="absolute top-3 bottom-0 left-[3.5px] w-px bg-border" aria-hidden />
          )}
          <span
            className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT_CLASS[entry.tone])}
            aria-hidden
          />
          <div className="flex min-w-0 flex-col">
            <span className="text-body break-words text-foreground">{entry.label}</span>
            <time className="text-caption text-muted-foreground" dateTime={entry.createdAt}>
              {Utilities.formatStepTime(entry.createdAt)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

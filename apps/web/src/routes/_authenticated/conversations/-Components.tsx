import { Link, useNavigate } from "@tanstack/react-router";
import { DownloadSimple, Flag, ThumbsDown, ThumbsUp, X } from "@phosphor-icons/react";
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
import {
  useConversation,
  useConversations,
  useExportConversations,
  useFlagConversation,
} from "./-data";

const Tone = Schemas.DashboardChipToneEnum;
const HEAD_CLASS = "h-auto px-4 py-3 text-caption font-normal text-muted-foreground";
const CELL_CLASS = "px-4 py-[13px] text-body";
// DEV_NOTE: Radix Select can't hold an empty value, so "no filter" is its own option
const ANY = "any";
const UNNAMED_USER = "Unnamed user";

const TABS: { value: Schemas.ConversationListTabEnum; label: string }[] = [
  { value: Schemas.ConversationListTabEnum.All, label: "All" },
  { value: Schemas.ConversationListTabEnum.NeedsAttention, label: "Needs attention" },
  { value: Schemas.ConversationListTabEnum.RatedDown, label: "Rated down" },
];

const OUTCOME_OPTIONS = [
  { value: ANY, label: "Any" },
  ...Object.values(Schemas.ConversationOutcomeFilterEnum).map((value) => ({
    value,
    label: Schemas.CONVERSATION_OUTCOME_FILTER_LABEL_MAP[value],
  })),
];

function outcomeTone(
  outcome: Schemas.ConversationOutcomeIntEnum | null,
): Schemas.DashboardChipToneEnum {
  switch (outcome) {
    case null:
      return Tone.Brand;
    case Schemas.ConversationOutcomeIntEnum.ActionDone:
      return Tone.Success;
    case Schemas.ConversationOutcomeIntEnum.Idk:
      return Tone.Warning;
    default:
      return Tone.Neutral;
  }
}

function toolTone(status: Schemas.ToolCallStatusIntEnum): Schemas.DashboardChipToneEnum {
  if (status === Schemas.ToolCallStatusIntEnum.Ok) return Tone.Success;
  if (status === Schemas.ToolCallStatusIntEnum.Blocked) return Tone.Warning;
  return Tone.Destructive;
}

function costNoteText(note: Schemas.ConversationCostNoteEnum | null): string | null {
  if (note === Schemas.ConversationCostNoteEnum.Pending) return "some cost is still coming in";
  if (note === Schemas.ConversationCostNoteEnum.Unknown) return "some cost is unknown";
  return null;
}

// DEV_NOTE: Only web links open from the dashboard
function isWebUrl(url: string | null): url is string {
  return url !== null && /^https?:\/\//i.test(url);
}

function RatingIcon({ rating }: Schemas.DashboardRatingIconProps) {
  if (rating === Schemas.FeedbackRatingIntEnum.Down) {
    return <ThumbsDown className="size-4 text-destructive" aria-label="Rated down" />;
  }
  if (rating === Schemas.FeedbackRatingIntEnum.Up) {
    return <ThumbsUp className="size-4 text-subtle-foreground" aria-label="Rated up" />;
  }
  return <span className="text-subtle-foreground">—</span>;
}

// DEV_NOTE: The whole page body, shared by /conversations and /conversations/$id (selectedId). Filters and the page live
// in the URL; a filter change goes back to page 1 and keeps the open conversation.
export function ConversationsPage({ search, selectedId }: Schemas.DashboardConversationsPageProps) {
  const navigate = useNavigate();
  const query = useConversations(search);
  const exportConversations = useExportConversations();
  const data = query.data;
  // DEV_NOTE: The previous filter's rows and counts stay up while the next ones load (keepPreviousData): dimmed and
  // marked busy, so they never read as the new tab's
  const isStale = query.isPlaceholderData;
  const tab = search.tab ?? Schemas.ConversationListTabEnum.All;

  const goTo = (next: Schemas.ConversationsPageSearch) => {
    const parsed = Schemas.ZConversationsPageSearch.parse(next);
    if (selectedId) {
      void navigate({ to: "/conversations/$id", params: { id: selectedId }, search: parsed });
    } else {
      void navigate({ to: "/conversations", search: parsed });
    }
  };
  const setFilter = (next: Partial<Schemas.ConversationsPageSearch>) =>
    goTo({ ...search, ...next, page: undefined });

  const configOptions = [
    { value: ANY, label: "Any" },
    ...(data?.configOptions ?? []).map((option) => ({
      value: option.publicId,
      label: `${option.chatbotName} v${option.configVersion}`,
    })),
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Conversations" description="Every chat with your chatbots">
        <Button
          variant="outline"
          disabled={exportConversations.isPending}
          onClick={() => exportConversations.mutate(search)}
        >
          <DownloadSimple />
          {exportConversations.isPending ? "Exporting…" : "Export"}
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={tab}
          onValueChange={(value) => {
            const next = Schemas.ZConversationListTab.safeParse(value);
            if (next.success) {
              setFilter({
                tab: next.data === Schemas.ConversationListTabEnum.All ? undefined : next.data,
              });
            }
          }}
          aria-label="Show"
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
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="Outcome"
            value={search.outcome ?? ANY}
            options={OUTCOME_OPTIONS}
            onValueChange={(value) => {
              const next = Schemas.ZConversationOutcomeFilter.safeParse(value);
              setFilter({ outcome: next.success ? next.data : undefined });
            }}
          />
          <FilterSelect
            label="Config"
            value={search.configId ?? ANY}
            options={configOptions}
            onValueChange={(value) => setFilter({ configId: value === ANY ? undefined : value })}
          />
        </div>
      </div>

      <div className="grid items-start gap-6 min-[1100px]:grid-cols-3">
        <div
          className={cn(
            "min-w-0",
            selectedId ? "min-[1100px]:col-span-2" : "min-[1100px]:col-span-3",
          )}
        >
          {query.isPending && <ListLoading />}
          {!query.isPending && !data && (
            <PageError title="Conversations didn't load" onRetry={() => void query.refetch()} />
          )}
          {data && (
            <div
              aria-busy={isStale}
              className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}
            >
              <ConversationList
                response={data}
                search={search}
                selectedId={selectedId}
                hasFilters={Boolean(search.tab || search.outcome || search.configId)}
                onClearFilters={() => goTo({})}
                onPage={(page) => goTo({ ...search, page: page === 1 ? undefined : page })}
              />
            </div>
          )}
        </div>
        {selectedId && <ConversationDetailCard publicId={selectedId} search={search} />}
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

function ConversationList({
  response,
  search,
  selectedId,
  hasFilters,
  onClearFilters,
  onPage,
}: Schemas.DashboardConversationListProps) {
  const conversations = response.conversations ?? [];
  const totalRecords = response.totalRecords ?? 0;
  const page = search.page ?? 1;
  const pageSize = Schemas.CONVERSATIONS_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));

  if (conversations.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border px-[22px] py-5">
        {hasFilters || page > 1 ? (
          <>
            <p className="text-body text-muted-foreground">No conversations match these filters.</p>
            <Button variant="outline" onClick={onClearFilters}>
              Clear filters
            </Button>
          </>
        ) : (
          <p className="text-body text-muted-foreground">
            No conversations yet. They show up here once people chat with your chatbot.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD_CLASS}>User</TableHead>
              <TableHead className={HEAD_CLASS}>First message</TableHead>
              <TableHead className={HEAD_CLASS}>Outcome</TableHead>
              <TableHead className={`${HEAD_CLASS} text-right`}>Turns</TableHead>
              <TableHead className={HEAD_CLASS}>Config</TableHead>
              <TableHead className={HEAD_CLASS}>Rating</TableHead>
              <TableHead className={HEAD_CLASS}>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.publicId}
                conversation={conversation}
                search={search}
                isSelected={conversation.publicId === selectedId}
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

function ConversationRow({
  conversation,
  search,
  isSelected,
}: Schemas.DashboardConversationRowProps) {
  const navigate = useNavigate();
  return (
    <TableRow
      className={cn("cursor-pointer", isSelected && "bg-surface-subtle")}
      data-state={isSelected ? "selected" : undefined}
      onClick={() =>
        void navigate({
          to: "/conversations/$id",
          params: { id: conversation.publicId },
          search,
        })
      }
    >
      <TableCell className={cn(CELL_CLASS, "whitespace-nowrap")}>
        {conversation.userName ?? <span className="text-muted-foreground">{UNNAMED_USER}</span>}
      </TableCell>
      <TableCell className={CELL_CLASS}>
        <Link
          to="/conversations/$id"
          params={{ id: conversation.publicId }}
          search={search}
          className="block max-w-[320px] truncate text-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          {conversation.title ?? (
            <span className="text-muted-foreground">
              {conversation.isContentPurged ? "Content deleted" : "No message yet"}
            </span>
          )}
        </Link>
      </TableCell>
      <TableCell className={CELL_CLASS}>
        <StatusChip label={conversation.outcomeLabel} tone={outcomeTone(conversation.outcome)} />
      </TableCell>
      <TableCell className={`${CELL_CLASS} text-right tabular-nums`}>
        {Utilities.formatCount(conversation.turnCount)}
      </TableCell>
      <TableCell className={CELL_CLASS}>
        {conversation.configVersion === null ? (
          <span className="text-subtle-foreground">—</span>
        ) : (
          <span className="font-mono text-mono-value text-muted-foreground">
            v{conversation.configVersion}
          </span>
        )}
      </TableCell>
      <TableCell className={CELL_CLASS}>
        <RatingIcon rating={conversation.rating} />
      </TableCell>
      <TableCell className={cn(CELL_CLASS, "whitespace-nowrap text-muted-foreground")}>
        {Utilities.formatWhen(conversation.createdAt)}
      </TableCell>
    </TableRow>
  );
}

// DEV_NOTE: The detail card (DESIGN.md §6: the third column at ≥1100px, below the list under it)
function ConversationDetailCard({ publicId, search }: Schemas.DashboardConversationDetailProps) {
  const query = useConversation(publicId);
  const conversation = query.data?.conversation;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <Card className="gap-0 py-0" role="region" aria-label="Conversation">
      <div className="flex items-start justify-between gap-3 px-[22px] pt-5 pb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-section text-foreground">
            {conversation ? (conversation.userName ?? UNNAMED_USER) : "Conversation"}
          </h2>
          {conversation && <DetailSummary conversation={conversation} />}
        </div>
        <Button variant="ghost" size="icon-sm" className="text-subtle-foreground" asChild>
          <Link to="/conversations" search={search} aria-label="Close">
            <X />
          </Link>
        </Button>
      </div>

      {query.isPending && (
        <div className="flex flex-col gap-3 px-[22px] pb-5" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
      )}
      {!query.isPending && !conversation && (
        <div className="px-[22px] pb-5">
          {isNotFound ? (
            <p className="text-body text-muted-foreground">
              This conversation isn't available. It may have been removed.
            </p>
          ) : (
            <PageError title="The conversation didn't load" onRetry={() => void query.refetch()} />
          )}
        </div>
      )}
      {conversation && <DetailBody conversation={conversation} />}
    </Card>
  );
}

function DetailSummary({ conversation }: Schemas.DashboardConversationProps) {
  const parts = [
    Utilities.formatWhenWithTime(conversation.createdAt),
    conversation.chatbotName,
    conversation.configVersion === null ? null : `config v${conversation.configVersion}`,
    Utilities.plural(conversation.turnCount, "turn"),
    Utilities.formatUsdPrecise(conversation.costUsd),
  ].filter((part): part is string => part !== null);
  const note = costNoteText(conversation.costNote);
  return (
    <p className="text-caption text-muted-foreground">
      {parts.join(", ")}
      {note && <span className="text-warning"> ({note})</span>}
    </p>
  );
}

function DetailBody({ conversation }: Schemas.DashboardConversationProps) {
  const flag = useFlagConversation(conversation.publicId);
  return (
    <>
      <div className="flex flex-col border-t">
        {conversation.isContentPurged && (
          <p className="mx-[22px] mt-4 rounded-lg bg-brand-soft px-3 py-2.5 text-caption text-foreground">
            The messages were deleted under your retention settings. Outcomes and costs stay.
          </p>
        )}
        {conversation.turns.length === 0 ? (
          <p className="px-[22px] py-5 text-body text-muted-foreground">No messages yet.</p>
        ) : (
          conversation.turns.map((turn) => (
            <ConversationTurnView key={turn.number} conversation={conversation} turn={turn} />
          ))
        )}
      </div>
      <div className="flex items-center gap-2 border-t px-[22px] py-4">
        <Button
          variant="outline"
          disabled={conversation.isFlagged || flag.isPending}
          onClick={() => flag.mutate()}
        >
          <Flag />
          {conversation.isFlagged ? "Flagged" : "Flag conversation"}
        </Button>
        {conversation.isFlagged && (
          <Link to="/quality" className="text-caption text-brand-text hover:text-foreground">
            Quality inbox
          </Link>
        )}
      </div>
    </>
  );
}

function ConversationTurnView({ conversation, turn }: Schemas.DashboardConversationTurnProps) {
  const userLabel = conversation.userName?.split(/\s+/)[0] ?? "User";
  const note = costNoteText(turn.costNote);
  return (
    <section className="flex flex-col gap-3 border-b px-[22px] py-4 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3 text-caption text-muted-foreground">
        <span>Turn {turn.number}</span>
        <span className="tabular-nums">
          {Utilities.formatUsdPrecise(turn.costUsd)}
          {note && <span className="text-warning"> ({note})</span>}
        </span>
      </div>
      {turn.entries.map((entry) =>
        entry.kind === Schemas.ConversationTurnEntryKindEnum.Tool ? (
          <ToolRow key={entry.publicId} toolCall={entry} />
        ) : (
          <MessageView
            key={entry.publicId}
            message={entry}
            speaker={entry.role === Schemas.MessageRoleIntEnum.User ? userLabel : "Assistant"}
          />
        ),
      )}
    </section>
  );
}

function MessageView({ message, speaker }: Schemas.DashboardConversationMessageProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-body break-words text-foreground">
        <span className="font-medium">{speaker}</span>{" "}
        {message.text ?? <span className="text-muted-foreground">Content deleted</span>}
        {message.rating !== null && (
          <span className="ml-1.5 inline-flex align-middle">
            <RatingIcon rating={message.rating} />
          </span>
        )}
      </p>
      {message.citations.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-caption text-muted-foreground">
          {message.citations.map((citation) => (
            <li key={citation.n}>
              [{citation.n}]{" "}
              {isWebUrl(citation.sourceUrl) ? (
                <a
                  href={citation.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-text hover:text-foreground"
                >
                  {citation.title ?? citation.sourceUrl}
                </a>
              ) : (
                (citation.title ?? "Uploaded document")
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolRow({ toolCall }: Schemas.DashboardConversationToolRowProps) {
  const { change } = toolCall;
  const detail = change ? change.summary : toolCall.errorLabel;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-surface-subtle px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-mono-value text-foreground">
            {toolCall.toolName ?? "Removed tool"}
          </span>
          <span className="font-mono text-mono-value text-muted-foreground">
            v{toolCall.toolVersion}
          </span>
          {detail && <span className="truncate text-caption text-muted-foreground">{detail}</span>}
        </p>
        {change ? (
          <StatusChip
            label={change.changeRequestStatusLabel}
            tone={Utilities.changeRequestTone(change.changeRequestStatus)}
          />
        ) : (
          <StatusChip
            label={toolCall.toolCallStatusLabel}
            tone={toolTone(toolCall.toolCallStatus)}
          />
        )}
      </div>
      {change && (
        <div className="flex items-center justify-between gap-3 text-caption">
          <span className="text-muted-foreground">{change.errorLabel}</span>
          <Link
            to="/changes/$id"
            params={{ id: change.publicId }}
            className="shrink-0 text-brand-text hover:text-foreground"
          >
            Open change
          </Link>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Flag, ThumbsDown, ThumbsUp, X } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Card } from "@app/ui/components/card";
import { Skeleton } from "@app/ui/components/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@app/ui/components/toggle-group";
import { cn } from "@app/ui/lib/utils";
import { PageError } from "@/components/page-state";
import { StatusChip } from "@/components/status-chip";
import { ApiError } from "@/providers/apiClient";
import Utilities from "@/utils";
import { QualityHeader, QualityViews } from "../-Components";
import {
  FeedbackThemeCloseEnum,
  useCloseFeedbackTheme,
  useFeedbackTheme,
  useFeedbackThemes,
} from "./-data";

const RATINGS: { value: Schemas.FeedbackThemeRatingFilterEnum; label: string }[] = [
  { value: Schemas.FeedbackThemeRatingFilterEnum.Disliked, label: "Didn't like" },
  { value: Schemas.FeedbackThemeRatingFilterEnum.Liked, label: "Liked" },
];

const TABS: { value: Schemas.FeedbackThemeListTabEnum; label: string }[] = [
  { value: Schemas.FeedbackThemeListTabEnum.Open, label: "Open" },
  { value: Schemas.FeedbackThemeListTabEnum.Resolved, label: "Resolved" },
  { value: Schemas.FeedbackThemeListTabEnum.Dismissed, label: "Dismissed" },
];

const EMPTY_TEXT: Record<Schemas.FeedbackThemeListTabEnum, string> = {
  [Schemas.FeedbackThemeListTabEnum.Open]:
    "No themes yet. They show up here when users leave a note with their rating and an AI groups notes that say the same thing.",
  [Schemas.FeedbackThemeListTabEnum.Resolved]: "No theme was marked resolved yet.",
  [Schemas.FeedbackThemeListTabEnum.Dismissed]: "No theme was dismissed yet.",
};

// DEV_NOTE: How many of a theme's notes show before Show all
const NOTES_SHOWN = 4;

const RATING_WORDS: Record<Schemas.FeedbackRatingIntEnum, string> = {
  [Schemas.FeedbackRatingIntEnum.Down]: "Didn't like",
  [Schemas.FeedbackRatingIntEnum.Up]: "Liked",
};

function RatingIcon({ rating }: { rating: Schemas.FeedbackRatingIntEnum }) {
  const Icon = rating === Schemas.FeedbackRatingIntEnum.Down ? ThumbsDown : ThumbsUp;
  return <Icon className="mt-0.5 size-4 shrink-0 text-subtle-foreground" aria-hidden />;
}

function noteCountText(theme: Schemas.FeedbackThemeListItem): string {
  const notes = `${Utilities.formatCount(theme.noteCount)} ${theme.noteCount === 1 ? "note" : "notes"}`;
  const people = `${Utilities.formatCount(theme.userCount)} ${theme.userCount === 1 ? "person" : "people"}`;
  return `${notes} from ${people}`;
}

// DEV_NOTE: Quality › User feedback (M7-10), shared by /quality/feedback and /quality/feedback/$id (selectedId). The
// thumb, the tab and the page live in the URL; a thumb or tab change goes back to page 1 and keeps the open theme.
export function FeedbackThemesPage({
  search,
  selectedId,
}: Schemas.DashboardFeedbackThemesPageProps) {
  const navigate = useNavigate();
  const query = useFeedbackThemes(search);
  const data = query.data;
  const isStale = query.isPlaceholderData;
  const rating = search.rating ?? Schemas.FeedbackThemeRatingFilterEnum.Disliked;
  const tab = search.tab ?? Schemas.FeedbackThemeListTabEnum.Open;

  const goTo = (next: Schemas.FeedbackThemesPageSearch) => {
    const parsed = Schemas.ZFeedbackThemesPageSearch.parse(next);
    if (selectedId) {
      void navigate({ to: "/quality/feedback/$id", params: { id: selectedId }, search: parsed });
    } else {
      void navigate({ to: "/quality/feedback", search: parsed });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <QualityHeader />
      <QualityViews current={Schemas.DashboardQualityViewEnum.Feedback} />

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={rating}
          onValueChange={(value) => {
            const next = Schemas.ZFeedbackThemeRatingFilter.safeParse(value);
            if (next.success) {
              goTo({
                tab: search.tab,
                rating:
                  next.data === Schemas.FeedbackThemeRatingFilterEnum.Disliked
                    ? undefined
                    : next.data,
              });
            }
          }}
          aria-label="Rating"
        >
          {RATINGS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} className="gap-1.5 px-3">
              {item.value === Schemas.FeedbackThemeRatingFilterEnum.Disliked ? (
                <ThumbsDown aria-hidden />
              ) : (
                <ThumbsUp aria-hidden />
              )}
              {item.label}
              {data?.ratingCounts && (
                <span className={cn("text-muted-foreground", isStale && "opacity-50")}>
                  {Utilities.formatCount(data.ratingCounts[item.value])}
                </span>
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={tab}
          onValueChange={(value) => {
            const next = Schemas.ZFeedbackThemeListTab.safeParse(value);
            if (next.success) {
              goTo({
                rating: search.rating,
                tab: next.data === Schemas.FeedbackThemeListTabEnum.Open ? undefined : next.data,
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
        <p className="grow basis-64 text-caption text-muted-foreground min-[1100px]:text-right">
          Grouped by AI from users' notes, with personal details removed
        </p>
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
            <PageError title="Themes didn't load" onRetry={() => void query.refetch()} />
          )}
          {data && (
            <div
              aria-busy={isStale}
              className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}
            >
              <FeedbackThemesList
                response={data}
                search={search}
                selectedId={selectedId}
                onPage={(page) => goTo({ ...search, page: page === 1 ? undefined : page })}
              />
            </div>
          )}
        </div>
        {selectedId && (
          <FeedbackThemeDetailCard publicId={selectedId} search={search} key={selectedId} />
        )}
      </div>
    </div>
  );
}

function ListLoading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-20 rounded-md" />
      ))}
    </div>
  );
}

function FeedbackThemesList({
  response,
  search,
  selectedId,
  onPage,
}: Schemas.DashboardFeedbackThemesListProps) {
  const themes = response.feedbackThemes ?? [];
  const totalRecords = response.totalRecords ?? 0;
  const page = search.page ?? 1;
  const pageSize = Schemas.FEEDBACK_THEMES_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));
  const tab = search.tab ?? Schemas.FeedbackThemeListTabEnum.Open;

  if (themes.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border px-[22px] py-5">
        <p className="text-body text-muted-foreground">
          {page > 1 ? "Nothing on this page." : EMPTY_TEXT[tab]}
        </p>
        {page > 1 && (
          <Button variant="outline" onClick={() => onPage(1)}>
            First page
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y overflow-hidden rounded-xl border" aria-label="Themes">
        {themes.map((theme) => (
          <FeedbackThemeRow
            key={theme.publicId}
            feedbackTheme={theme}
            search={search}
            isSelected={theme.publicId === selectedId}
          />
        ))}
      </ul>
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

// DEV_NOTE: One theme (the design canvas): thumb icon, label with an "Issue opened" chip when it opened a Quality item,
// its newest note's summary, and how many notes from how many people, latest when
function FeedbackThemeRow({
  feedbackTheme,
  search,
  isSelected,
}: Schemas.DashboardFeedbackThemeRowProps) {
  return (
    <li className={cn("relative flex gap-3 px-[22px] py-4", isSelected && "bg-surface-subtle")}>
      <RatingIcon rating={feedbackTheme.rating} />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/quality/feedback/$id"
            params={{ id: feedbackTheme.publicId }}
            search={search}
            className="text-body font-medium break-words text-foreground after:absolute after:inset-0"
            aria-current={isSelected ? "true" : undefined}
          >
            {feedbackTheme.label}
          </Link>
          {feedbackTheme.qualityIssuePublicId && (
            <StatusChip label="Issue opened" tone={Schemas.DashboardChipToneEnum.Warning} />
          )}
        </div>
        {feedbackTheme.latestSummary && (
          <p className="line-clamp-2 text-body break-words text-subtle-foreground">
            "{feedbackTheme.latestSummary}"
          </p>
        )}
        <p className="text-caption text-muted-foreground">
          {noteCountText(feedbackTheme)}
          {feedbackTheme.latestNoteAt &&
            `, latest ${Utilities.formatWhen(feedbackTheme.latestNoteAt)}`}
        </p>
      </div>
    </li>
  );
}

// DEV_NOTE: The detail card (DESIGN.md §6: the third column at ≥1100px, below the list under it)
function FeedbackThemeDetailCard({
  publicId,
  search,
}: Schemas.DashboardFeedbackThemeDetailCardProps) {
  const query = useFeedbackTheme(publicId);
  const feedbackTheme = query.data?.feedbackTheme;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <Card className="relative gap-0 py-0" role="region" aria-label="Theme">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-4 right-4 text-subtle-foreground"
        asChild
      >
        <Link to="/quality/feedback" search={search} aria-label="Close">
          <X />
        </Link>
      </Button>
      {query.isPending && (
        <div className="flex flex-col gap-3 px-[22px] py-5" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-6 w-32 rounded-md" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-10 rounded-lg" />
        </div>
      )}
      {!query.isPending && !feedbackTheme && (
        <div className="px-[22px] py-5 pr-14">
          {isNotFound ? (
            <p className="text-body text-muted-foreground">
              This theme isn't available. It may have been removed.
            </p>
          ) : (
            <PageError title="The theme didn't load" onRetry={() => void query.refetch()} />
          )}
        </div>
      )}
      {feedbackTheme && <FeedbackThemeDetail feedbackTheme={feedbackTheme} />}
    </Card>
  );
}

// DEV_NOTE: One theme: when it started and grew, the Quality item it opened, what people said (rewritten, no personal
// details; each opens its conversation) and, while Open, Mark resolved and Dismiss
function FeedbackThemeDetail({ feedbackTheme }: Schemas.DashboardFeedbackThemeDetailProps) {
  const close = useCloseFeedbackTheme(feedbackTheme.publicId);
  const [isShowingAll, setIsShowingAll] = useState(false);
  const isOpen = feedbackTheme.feedbackThemeStatus === Schemas.FeedbackThemeStatusIntEnum.Open;
  const notes = isShowingAll ? feedbackTheme.notes : feedbackTheme.notes.slice(0, NOTES_SHOWN);

  return (
    <>
      <div className="flex flex-col items-start gap-1.5 px-[22px] pt-5 pr-14 pb-4">
        <p className="text-caption text-muted-foreground">
          {RATING_WORDS[feedbackTheme.rating]}, first{" "}
          {Utilities.formatWhen(feedbackTheme.createdAt)}
          {feedbackTheme.latestNoteAt &&
            `, latest ${Utilities.formatWhenWithTime(feedbackTheme.latestNoteAt)}`}
        </p>
        <h2 className="text-section break-words text-foreground">{feedbackTheme.label}</h2>
        <p className="text-body text-subtle-foreground">{noteCountText(feedbackTheme)}</p>
        {!isOpen && (
          <StatusChip
            label={feedbackTheme.feedbackThemeStatusLabel}
            tone={
              feedbackTheme.feedbackThemeStatus === Schemas.FeedbackThemeStatusIntEnum.Resolved
                ? Schemas.DashboardChipToneEnum.Success
                : Schemas.DashboardChipToneEnum.Neutral
            }
          />
        )}
      </div>

      {feedbackTheme.qualityIssuePublicId && (
        <div className="mx-[22px] flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-3 text-body text-warning">
          <Flag className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            Became a Quality issue at {Schemas.FEEDBACK_THEME_QUALITY_MIN_NOTES} notes from{" "}
            {Schemas.FEEDBACK_THEME_QUALITY_MIN_USERS} people.{" "}
            <Link
              to="/quality/$id"
              params={{ id: feedbackTheme.qualityIssuePublicId }}
              className="font-medium text-warning underline"
            >
              View issue
            </Link>
          </p>
        </div>
      )}

      <div className="flex flex-col gap-0.5 px-[22px] pt-4 pb-1">
        <h3 className="text-body font-medium text-foreground">What people said</h3>
        <p className="text-caption text-muted-foreground">
          Rewritten by AI without personal details
        </p>
      </div>
      {feedbackTheme.notes.length === 0 ? (
        <p className="px-[22px] py-3 text-body text-muted-foreground">
          No notes are left in this theme: they were edited or their ratings changed.
        </p>
      ) : (
        <ul className="flex flex-col divide-y px-[22px]" aria-label="Notes">
          {notes.map((note) => (
            <li key={note.publicId} className="flex flex-col gap-1 py-3">
              <p className="text-body break-words text-foreground">{note.summary}</p>
              <p className="text-caption text-muted-foreground">
                {Utilities.formatWhen(note.createdAt)}
                {note.conversationPublicId && (
                  <>
                    {" · "}
                    <Link
                      to="/conversations/$id"
                      params={{ id: note.conversationPublicId }}
                      className="text-brand-text hover:text-foreground"
                    >
                      View conversation
                    </Link>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      {!isShowingAll && feedbackTheme.notes.length > NOTES_SHOWN && (
        <div className="px-[22px] pb-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-subtle-foreground"
            onClick={() => setIsShowingAll(true)}
          >
            Show all {Utilities.formatCount(feedbackTheme.notes.length)}
          </Button>
        </div>
      )}

      {isOpen && (
        <div className="mt-2 flex flex-col gap-3 border-t px-[22px] py-4">
          <p className="text-caption text-muted-foreground">
            Resolve it once the chatbot answers better. New notes like these then start a new theme.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={close.isPending}
              onClick={() => close.mutate(FeedbackThemeCloseEnum.Resolve)}
            >
              <Check aria-hidden />
              Mark resolved
            </Button>
            <Button
              variant="ghost"
              className="text-subtle-foreground"
              disabled={close.isPending}
              onClick={() => close.mutate(FeedbackThemeCloseEnum.Dismiss)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

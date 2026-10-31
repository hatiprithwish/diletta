import { useState } from "react";
import type { ComponentType } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { Check, Flag, Plus, ThumbsDown, Warning, X } from "@phosphor-icons/react";
import type { IconProps } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Card } from "@app/ui/components/card";
import { Dialog, DialogContent } from "@app/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@app/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@app/ui/components/select";
import { Skeleton } from "@app/ui/components/skeleton";
import { Textarea } from "@app/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@app/ui/components/toggle-group";
import { cn } from "@app/ui/lib/utils";
import { EvalCaseForm } from "@/components/eval-case-form";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { StatusChip } from "@/components/status-chip";
import { ApiError } from "@/providers/apiClient";
import Utilities from "@/utils";
import {
  useCloseQualityIssue,
  useConvertQualityIssue,
  useDraftQualityTest,
  useQualityIssue,
  useQualityIssues,
  useTriageQualityIssue,
} from "./-data";

const UNTITLED = "Untitled conversation";
const NOT_TRIAGED = "Not triaged";

// DEV_NOTE: An issue's title: its conversation's, for a growing group of unanswered questions (M5-6) the group's, or for
// a check on the whole chatbot (a health drop, M5-5, no conversation) the chatbot it is about
function issueTitle(qualityIssue: Schemas.QualityIssueListItem): string {
  if (qualityIssue.docGapCluster) {
    return `Unanswered questions: ${qualityIssue.docGapCluster.label}`;
  }
  if (qualityIssue.isChatbotWide) {
    return `Daily health check: ${qualityIssue.chatbotName ?? "a removed chatbot"}`;
  }
  return qualityIssue.conversation?.title ?? UNTITLED;
}

const TABS: { value: Schemas.QualityIssueListTabEnum; label: string }[] = [
  { value: Schemas.QualityIssueListTabEnum.Open, label: "Open" },
  { value: Schemas.QualityIssueListTabEnum.Converted, label: "Converted" },
  { value: Schemas.QualityIssueListTabEnum.Fixed, label: "Fixed" },
  { value: Schemas.QualityIssueListTabEnum.Dismissed, label: "Dismissed" },
];

// DEV_NOTE: Where an issue came from, in the dashboard's words (DESIGN.md §8)
const SOURCE_TEXT: Record<Schemas.QualityIssueSourceIntEnum, string> = {
  [Schemas.QualityIssueSourceIntEnum.User]: "From a user",
  [Schemas.QualityIssueSourceIntEnum.Admin]: "From an admin",
  [Schemas.QualityIssueSourceIntEnum.System]: "Automatic check",
};

const SOURCE_ICON: Record<Schemas.QualityIssueSourceIntEnum, ComponentType<IconProps>> = {
  [Schemas.QualityIssueSourceIntEnum.User]: ThumbsDown,
  [Schemas.QualityIssueSourceIntEnum.Admin]: Flag,
  [Schemas.QualityIssueSourceIntEnum.System]: Warning,
};

const EMPTY_TEXT: Record<Schemas.QualityIssueListTabEnum, string> = {
  [Schemas.QualityIssueListTabEnum.Open]:
    "Nothing to triage. Issues show up here when a user rates a reply down, an admin flags a conversation, a check fails or a chatbot's day goes worse than usual.",
  [Schemas.QualityIssueListTabEnum.Converted]: "No issue has become a test yet.",
  [Schemas.QualityIssueListTabEnum.Fixed]: "No issue was marked fixed yet.",
  [Schemas.QualityIssueListTabEnum.Dismissed]: "No issue was dismissed yet.",
};

const TYPE_OPTIONS = Object.values(Schemas.QualityIssueTypeIntEnum)
  .filter((value): value is Schemas.QualityIssueTypeIntEnum => typeof value === "number")
  .map((value) => ({ value: String(value), label: Schemas.QUALITY_ISSUE_TYPE_LABEL_MAP[value] }));

// DEV_NOTE: A closed issue's chip: converted = success, fixed = success, dismissed = neutral
const STATUS_TONE: Record<Schemas.QualityIssueStatusIntEnum, Schemas.DashboardChipToneEnum> = {
  [Schemas.QualityIssueStatusIntEnum.Open]: Schemas.DashboardChipToneEnum.Warning,
  [Schemas.QualityIssueStatusIntEnum.Converted]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.QualityIssueStatusIntEnum.Fixed]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.QualityIssueStatusIntEnum.Dismissed]: Schemas.DashboardChipToneEnum.Neutral,
};

// DEV_NOTE: The type chip: "Not triaged" (warning) until an admin picks a type
function TypeChip({ issueTypeLabel }: Pick<Schemas.QualityIssueListItem, "issueTypeLabel">) {
  return issueTypeLabel === null ? (
    <StatusChip label={NOT_TRIAGED} tone={Schemas.DashboardChipToneEnum.Warning} />
  ) : (
    <StatusChip label={issueTypeLabel} tone={Schemas.DashboardChipToneEnum.Neutral} />
  );
}

// DEV_NOTE: The whole page body, shared by /quality and /quality/$id (selectedId). The tab and the page live in the URL;
// a tab change goes back to page 1 and keeps the open issue.
export function QualityPage({ search, selectedId }: Schemas.DashboardQualityPageProps) {
  const navigate = useNavigate();
  const query = useQualityIssues(search);
  const data = query.data;
  // DEV_NOTE: The previous tab's rows and counts stay up while the next ones load (keepPreviousData): dimmed and marked
  // busy, so they never read as the new tab's
  const isStale = query.isPlaceholderData;
  const tab = search.tab ?? Schemas.QualityIssueListTabEnum.Open;

  const goTo = (next: Schemas.QualityPageSearch) => {
    const parsed = Schemas.ZQualityPageSearch.parse(next);
    if (selectedId) {
      void navigate({ to: "/quality/$id", params: { id: selectedId }, search: parsed });
    } else {
      void navigate({ to: "/quality", search: parsed });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quality"
        description="Problems found in real conversations, from users, admins and automatic checks"
      >
        <Button variant="outline" asChild>
          <Link to="/conversations">
            <Flag aria-hidden />
            Flag a conversation
          </Link>
        </Button>
      </PageHeader>

      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={tab}
        onValueChange={(value) => {
          const next = Schemas.ZQualityIssueListTab.safeParse(value);
          if (next.success) {
            goTo({
              tab: next.data === Schemas.QualityIssueListTabEnum.Open ? undefined : next.data,
            });
          }
        }}
        aria-label="Show"
        className="flex-wrap self-start"
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

      <div className="grid items-start gap-6 min-[1100px]:grid-cols-3">
        <div
          className={cn(
            "min-w-0",
            selectedId ? "min-[1100px]:col-span-2" : "min-[1100px]:col-span-3",
          )}
        >
          {query.isPending && <ListLoading />}
          {!query.isPending && !data && (
            <PageError title="Issues didn't load" onRetry={() => void query.refetch()} />
          )}
          {data && (
            <div
              aria-busy={isStale}
              className={cn("transition-opacity", isStale && "pointer-events-none opacity-50")}
            >
              <QualityList
                response={data}
                search={search}
                selectedId={selectedId}
                onPage={(page) => goTo({ ...search, page: page === 1 ? undefined : page })}
              />
            </div>
          )}
        </div>
        {selectedId && <QualityDetailCard publicId={selectedId} search={search} />}
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

function QualityList({ response, search, selectedId, onPage }: Schemas.DashboardQualityListProps) {
  const issues = response.qualityIssues ?? [];
  const totalRecords = response.totalRecords ?? 0;
  const page = search.page ?? 1;
  const pageSize = Schemas.QUALITY_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));
  const tab = search.tab ?? Schemas.QualityIssueListTabEnum.Open;

  if (issues.length === 0) {
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
      <ul className="divide-y overflow-hidden rounded-xl border" aria-label="Issues">
        {issues.map((issue) => (
          <QualityRow
            key={issue.publicId}
            qualityIssue={issue}
            search={search}
            isSelected={issue.publicId === selectedId}
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

// DEV_NOTE: One issue (DESIGN.md §6): source icon, title (the conversation's) with its type chip, what it is about (the
// admin's note, else the rated reply) and where it came from, when
function QualityRow({ qualityIssue, search, isSelected }: Schemas.DashboardQualityRowProps) {
  const Icon = SOURCE_ICON[qualityIssue.source];
  const summary =
    qualityIssue.note ?? (qualityIssue.ratedReply ? `"${qualityIssue.ratedReply}"` : null);
  return (
    <li className={cn("relative flex gap-3 px-[22px] py-4", isSelected && "bg-surface-subtle")}>
      <Icon className="mt-0.5 size-4 shrink-0 text-subtle-foreground" aria-hidden />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/quality/$id"
            params={{ id: qualityIssue.publicId }}
            search={search}
            className="text-body font-medium break-words text-foreground after:absolute after:inset-0"
            aria-current={isSelected ? "true" : undefined}
          >
            {issueTitle(qualityIssue)}
          </Link>
          <TypeChip issueTypeLabel={qualityIssue.issueTypeLabel} />
        </div>
        {summary && <p className="line-clamp-2 text-body break-words text-foreground">{summary}</p>}
        <p className="text-caption text-muted-foreground">
          {SOURCE_TEXT[qualityIssue.source]}, {Utilities.formatWhen(qualityIssue.createdAt)}
        </p>
      </div>
    </li>
  );
}

// DEV_NOTE: The detail card (DESIGN.md §6: the third column at ≥1100px, below the list under it)
function QualityDetailCard({ publicId, search }: Schemas.DashboardQualityDetailCardProps) {
  const query = useQualityIssue(publicId);
  const qualityIssue = query.data?.qualityIssue;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <Card className="relative gap-0 py-0" role="region" aria-label="Issue">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-4 right-4 text-subtle-foreground"
        asChild
      >
        <Link to="/quality" search={search} aria-label="Close">
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
      {!query.isPending && !qualityIssue && (
        <div className="px-[22px] py-5 pr-14">
          {isNotFound ? (
            <p className="text-body text-muted-foreground">
              This issue isn't available. It may have been removed.
            </p>
          ) : (
            <PageError title="The issue didn't load" onRetry={() => void query.refetch()} />
          )}
        </div>
      )}
      {qualityIssue && <QualityDetail key={qualityIssue.publicId} qualityIssue={qualityIssue} />}
    </Card>
  );
}

// DEV_NOTE: One issue: where it came from, the question and reply it is about, its triage and, while Open, Create test,
// Mark fixed and Dismiss. A chatbot-wide check (a health drop, M5-5) has no conversation: no excerpt, no Create test, no
// Open conversation; its note says what dropped.
export function QualityDetail({ qualityIssue }: Schemas.DashboardQualityDetailProps) {
  const { conversation } = qualityIssue;
  const isOpen = qualityIssue.qualityIssueStatus === Schemas.QualityIssueStatusIntEnum.Open;
  const close = useCloseQualityIssue(qualityIssue.publicId);
  const draftTest = useDraftQualityTest(qualityIssue.publicId);
  const [draft, setDraft] = useState<Schemas.QualityTestDraft | null>(null);
  const isBusy = close.isPending || draftTest.isPending;
  const speaker = conversation?.userName?.split(" ")[0] || "User";

  const createTest = () => {
    draftTest
      .mutateAsync()
      .then((response) => setDraft(response.draft ?? null))
      .catch(() => undefined);
  };

  return (
    <>
      <div className="flex flex-col items-start gap-1.5 px-[22px] pt-5 pr-14 pb-4">
        <p className="text-caption text-muted-foreground">
          {SOURCE_TEXT[qualityIssue.source]}, {Utilities.formatWhenWithTime(qualityIssue.createdAt)}
        </p>
        <h2 className="text-section break-words text-foreground">{issueTitle(qualityIssue)}</h2>
        {!isOpen && (
          <StatusChip
            label={qualityIssue.qualityIssueStatusLabel}
            tone={STATUS_TONE[qualityIssue.qualityIssueStatus]}
          />
        )}
      </div>

      <div className="mx-[22px] mb-4 flex flex-col gap-2.5 rounded-lg bg-surface-subtle px-3.5 py-3">
        {qualityIssue.excerpt.length === 0 && (
          <p className="text-body text-muted-foreground">
            {qualityIssue.docGapCluster
              ? "Several people asked this and the help docs had no answer. Add a document for it on the Knowledge page; that closes this item too."
              : qualityIssue.isChatbotWide
                ? "This check looks at the whole chatbot's day, not one conversation. The note says what changed."
                : qualityIssue.isContentPurged
                  ? "The chat's content was deleted."
                  : "No messages yet."}
          </p>
        )}
        {qualityIssue.excerpt.map((message) => (
          // DEV_NOTE: An excerpt holds at most one message per role
          <p key={message.role} className="text-body break-words text-foreground">
            <span className="font-medium">
              {message.role === Schemas.MessageRoleIntEnum.User ? speaker : "Assistant"}
            </span>{" "}
            {message.text}
          </p>
        ))}
        {qualityIssue.rating === Schemas.FeedbackRatingIntEnum.Down && (
          <p className="text-body text-muted-foreground">Rated not helpful</p>
        )}
        {qualityIssue.source === Schemas.QualityIssueSourceIntEnum.User &&
          qualityIssue.rating === Schemas.FeedbackRatingIntEnum.Up && (
            <p className="text-body text-muted-foreground">Later rated helpful</p>
          )}
      </div>

      {isOpen ? (
        <QualityTriage qualityIssue={qualityIssue} />
      ) : (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 border-t px-[22px] py-4 text-body">
          <dt className="text-muted-foreground">Issue type</dt>
          <dd className="text-foreground">{qualityIssue.issueTypeLabel ?? NOT_TRIAGED}</dd>
          {qualityIssue.note && (
            <>
              <dt className="text-muted-foreground">Note</dt>
              <dd className="break-words text-foreground">{qualityIssue.note}</dd>
            </>
          )}
          {qualityIssue.evalCase && (
            <>
              <dt className="text-muted-foreground">Test</dt>
              <dd className="break-words text-foreground">{qualityIssue.evalCase.name}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Last update</dt>
          <dd className="text-foreground">
            {Utilities.formatWhenWithTime(qualityIssue.updatedAt)}
          </dd>
        </dl>
      )}

      {isOpen && (
        <div className="flex flex-col gap-3 border-t px-[22px] py-4">
          {!qualityIssue.isChatbotWide && (
            <p className="text-caption text-muted-foreground">
              Creating a test rewrites this chat without personal details. You review it before it's
              saved.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {qualityIssue.docGapCluster && (
              <Button asChild>
                <Link to="/knowledge">Open Knowledge</Link>
              </Button>
            )}
            {!qualityIssue.isChatbotWide && (
              <Button disabled={isBusy} onClick={createTest}>
                <Plus aria-hidden />
                {draftTest.isPending ? "Rewriting…" : "Create test"}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={isBusy}
              onClick={() => close.mutate(Schemas.QualityIssueStatusIntEnum.Fixed)}
            >
              <Check aria-hidden />
              Mark fixed
            </Button>
            <Button
              variant="ghost"
              className="text-subtle-foreground"
              disabled={isBusy}
              onClick={() => close.mutate(Schemas.QualityIssueStatusIntEnum.Dismissed)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {(conversation || qualityIssue.changeRequestPublicId) && (
        <div className="flex flex-wrap gap-2 border-t px-[22px] py-4">
          {conversation && (
            <Button variant="outline" asChild>
              <Link to="/conversations/$id" params={{ id: conversation.publicId }}>
                Open conversation
              </Link>
            </Button>
          )}
          {qualityIssue.changeRequestPublicId && (
            <Button variant="outline" asChild>
              <Link to="/changes/$id" params={{ id: qualityIssue.changeRequestPublicId }}>
                Open change
              </Link>
            </Button>
          )}
        </div>
      )}

      <QualityTestDialog
        publicId={qualityIssue.publicId}
        draft={draft}
        onClose={() => setDraft(null)}
      />
    </>
  );
}

function noteIssue(value: string): string | undefined {
  return value.trim().length > Schemas.QUALITY_ISSUE_NOTE_MAX_CHARS
    ? `Keep the note under ${Utilities.formatCount(Schemas.QUALITY_ISSUE_NOTE_MAX_CHARS)} characters.`
    : undefined;
}

// DEV_NOTE: Triage while Open: the type is saved as soon as it is picked; the note with Save note
function QualityTriage({ qualityIssue }: Schemas.DashboardQualityDetailProps) {
  const triage = useTriageQualityIssue(qualityIssue.publicId);
  const form = useForm({
    defaultValues: { note: qualityIssue.note ?? "" },
    onSubmit: async ({ value }) => {
      const saved = await triage.mutateAsync({ note: value.note });
      // DEV_NOTE: The answer may carry no issue (saved, but the read after it failed): keep what was saved
      form.reset({
        note: saved.qualityIssue ? (saved.qualityIssue.note ?? "") : value.note.trim(),
      });
    },
  });

  return (
    <div className="flex flex-col gap-4 border-t px-[22px] py-4">
      <Field>
        <FieldLabel htmlFor={`issue-type-${qualityIssue.publicId}`}>Issue type</FieldLabel>
        <Select
          value={qualityIssue.issueType === null ? undefined : String(qualityIssue.issueType)}
          disabled={triage.isPending}
          onValueChange={(value) => {
            const issueType = Number(value) as Schemas.QualityIssueTypeIntEnum;
            if (issueType !== qualityIssue.issueType) triage.mutate({ issueType });
          }}
        >
          <SelectTrigger id={`issue-type-${qualityIssue.publicId}`} className="w-full">
            <SelectValue placeholder="Choose a type" />
          </SelectTrigger>
          <SelectContent>
            {TYPE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit().catch(() => undefined);
        }}
      >
        <form.Field name="note" validators={{ onChange: ({ value }) => noteIssue(value) }}>
          {(field) => (
            <Field data-invalid={field.state.meta.errors.length > 0}>
              <FieldLabel htmlFor={`issue-note-${qualityIssue.publicId}`}>Note</FieldLabel>
              <Textarea
                id={`issue-note-${qualityIssue.publicId}`}
                name={field.name}
                rows={2}
                placeholder="What went wrong"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                aria-invalid={field.state.meta.errors.length > 0}
              />
              <FieldError
                errors={field.state.meta.errors.map((message) => ({ message: String(message) }))}
              />
            </Field>
          )}
        </form.Field>
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting, state.isDirty] as const}
        >
          {([canSubmit, isSubmitting, isDirty]) =>
            isDirty && (
              <Button
                type="submit"
                variant="outline"
                className="self-start"
                disabled={!canSubmit || isSubmitting}
              >
                {isSubmitting ? "Saving…" : "Save note"}
              </Button>
            )
          }
        </form.Subscribe>
      </form>
    </div>
  );
}

// DEV_NOTE: Create test's review. The admin edits the rewrite (name, each message, rubric) and saves it as it is: the
// server keeps nothing from the draft but what comes back here.
function QualityTestDialog({ publicId, draft, onClose }: Schemas.DashboardQualityTestDialogProps) {
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {draft && <QualityTestForm publicId={publicId} draft={draft} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function QualityTestForm({
  publicId,
  draft,
  onClose,
}: Schemas.DashboardQualityTestDialogProps & { draft: Schemas.QualityTestDraft }) {
  const convert = useConvertQualityIssue(publicId);
  const save = async (value: Schemas.QualityTestDraft) => {
    try {
      await convert.mutateAsync(value);
    } catch (error) {
      // DEV_NOTE: A 409 (closed meanwhile, or the chatbot is gone) can't succeed on a retry: the review closes
      if (error instanceof ApiError && error.status === 409) onClose();
      throw error;
    }
    onClose();
  };

  return (
    <EvalCaseForm
      defaultValues={draft}
      canEditMessages={false}
      title="Review the test"
      description="The chat was rewritten without personal details. Check that nothing personal is left, then save. The test is saved as you see it."
      submitLabel="Save test"
      onSubmit={save}
      onCancel={onClose}
    />
  );
}

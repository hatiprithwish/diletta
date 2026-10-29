import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, DotsThree, FileText, Plus, X } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Card } from "@app/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@app/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@app/ui/components/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@app/ui/components/sheet";
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
import { EvalCaseForm } from "@/components/eval-case-form";
import { MetricCell, MetricStrip } from "@/components/metric-strip";
import { PageHeader } from "@/components/page-header";
import { Pager } from "@/components/pager";
import { PageError } from "@/components/page-state";
import { StatusChip } from "@/components/status-chip";
import { ApiError } from "@/providers/apiClient";
import Utilities from "@/utils";
import {
  useCreateTestCase,
  useTestCase,
  useTestCases,
  useTestRun,
  useTestRunCase,
  useTestRunCases,
  useTestRuns,
  useTestTranscript,
  useTestsSummary,
  useUpdateTestCase,
} from "./-data";

const Tone = Schemas.DashboardChipToneEnum;
const { Queued, Running, Done } = Schemas.EvalRunStatusIntEnum;
const { Runs, Cases } = Schemas.TestsPageTabEnum;

// DEV_NOTE: Run triggers in the dashboard's words (DESIGN.md §8)
const TRIGGER_TEXT: Record<Schemas.EvalRunTriggerIntEnum, string> = {
  [Schemas.EvalRunTriggerIntEnum.Gate]: "Publish check",
  [Schemas.EvalRunTriggerIntEnum.Manual]: "Manual",
  [Schemas.EvalRunTriggerIntEnum.Nightly]: "Nightly platform suite",
};

// DEV_NOTE: A config still being worked on reads "v13 draft"
const DRAFT_CONFIG_STATUSES: ReadonlySet<Schemas.ChatbotConfigStatusIntEnum> = new Set([
  Schemas.ChatbotConfigStatusIntEnum.Draft,
  Schemas.ChatbotConfigStatusIntEnum.Testing,
  Schemas.ChatbotConfigStatusIntEnum.Ready,
]);

const EMPTY_CASE: Schemas.EvalCaseDraft = {
  name: "",
  messages: [{ role: Schemas.EvalCaseMessageRoleEnum.User, text: "" }],
  rubric: "",
};

type RunResult = Schemas.DashboardTestRunResultProps["evalRun"];

// DEV_NOTE: A run's outcome: Passed / Failed once Done; Queued and Running as they are; a run that stopped (status
// Failed) "Didn't finish", so it never reads as a failed test
function runResult(evalRun: RunResult): { label: string; tone: Schemas.DashboardChipToneEnum } {
  if (evalRun.evalRunStatus === Done) {
    return evalRun.hasPassed
      ? { label: "Passed", tone: Tone.Success }
      : { label: "Failed", tone: Tone.Destructive };
  }
  if (evalRun.evalRunStatus === Queued || evalRun.evalRunStatus === Running) {
    return { label: evalRun.evalRunStatusLabel, tone: Tone.Brand };
  }
  return { label: "Didn't finish", tone: Tone.Warning };
}

function RunResultChip({ evalRun }: Schemas.DashboardTestRunResultProps) {
  const { label, tone } = runResult(evalRun);
  return <StatusChip label={label} tone={tone} />;
}

// DEV_NOTE: A case's result in a run; null = the run is still grading it (never shown as failed)
function CaseResultChip({ hasPassed }: Schemas.DashboardTestCaseResultProps) {
  if (hasPassed === null) return <StatusChip label="Running" tone={Tone.Brand} />;
  return hasPassed ? (
    <StatusChip label="Passed" tone={Tone.Success} />
  ) : (
    <StatusChip label="Failed" tone={Tone.Destructive} />
  );
}

// DEV_NOTE: The case card's line under its name: "failed 1 of 3 attempts", "passed all 3 attempts", or while the run is
// still grading it "running, 1 of 3 attempts passed so far"
function caseResultText(runCase: Schemas.EvalRunCaseItem, k: number): string {
  if (runCase.hasPassed === null) {
    return `running, ${runCase.passedAttemptCount} of ${Utilities.plural(k, "attempt")} passed so far`;
  }
  if (runCase.hasPassed) return `passed all ${Utilities.plural(k, "attempt")}`;
  return `failed ${runCase.attemptCount - runCase.passedAttemptCount} of ${Utilities.plural(runCase.attemptCount, "attempt")}`;
}

function configText(config: Schemas.EvalRunListItem["config"]): string {
  return `v${config.configVersion}${DRAFT_CONFIG_STATUSES.has(config.chatbotConfigStatus) ? " draft" : ""}`;
}

function casesText(evalRun: Schemas.EvalRunListItem): string {
  return evalRun.caseCount === null || evalRun.passAllKCount === null
    ? "—"
    : `${Utilities.formatCount(evalRun.passAllKCount)} / ${Utilities.formatCount(evalRun.caseCount)}`;
}

function safetyText({ safety }: Schemas.EvalRunListItem): string {
  return safety.totalCount === 0 ? "—" : `${safety.passedCount} / ${safety.totalCount}`;
}

// DEV_NOTE: A run with no cost yet (running, or the platform's own suite) shows a dash, not $0.00
function costText(costUsd: string): string {
  return Number(costUsd) === 0 ? "—" : Utilities.formatUsd(costUsd);
}

// DEV_NOTE: The strip's note under a config's result: cases passed and how the safety cases went
function configNote(run: Schemas.EvalRunListItem): {
  note: string;
  tone: Schemas.DashboardToneEnum;
} {
  const failedSafety = run.safety.totalCount - run.safety.passedCount;
  const isDone = run.evalRunStatus === Done;
  const safetyNote =
    run.safety.totalCount === 0
      ? null
      : failedSafety === 0
        ? "all safety"
        : Utilities.plural(failedSafety, "safety case");
  if (!isDone) {
    return {
      note: `Started ${Utilities.formatWhenWithTime(run.createdAt)}`,
      tone: Schemas.DashboardToneEnum.Neutral,
    };
  }
  if (run.hasPassed) {
    return {
      note: [casesText(run), safetyNote].filter(Boolean).join(", "),
      tone: Schemas.DashboardToneEnum.Positive,
    };
  }
  return {
    note: failedSafety > 0 && safetyNote ? safetyNote : `${casesText(run)} passed`,
    tone: Schemas.DashboardToneEnum.Negative,
  };
}

// DEV_NOTE: Keys for rows with no id (grader checks, transcript entries): the row's text plus how many times that text
// came before, so repeats ("Yes.") stay unique. Both lists are fixed once written, so the keys never move.
function contentKeys<T>(items: T[], textOf: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const text = textOf(item);
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return `${count}:${text}`;
  });
}

function entryText(entry: Schemas.EvalTranscriptEntryView): string {
  return entry.kind === Schemas.EvalTranscriptEntryKindEnum.Message
    ? `${entry.role}:${entry.text}`
    : `${entry.toolName}:${entry.toolVersion}:${entry.summary ?? ""}`;
}

function EmptyBox({ text }: Schemas.DashboardTestsEmptyProps) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border px-[22px] py-5">
      <p className="text-body text-muted-foreground">{text}</p>
    </div>
  );
}

// DEV_NOTE: The whole /tests body (DESIGN.md dashboard-Tests): header with New case, the metric strip, then Runs or
// Cases. Running tests comes with the harness (M5-2), so there is no Run tests button yet.
export function TestsPage({ search }: Schemas.DashboardTestsPageProps) {
  const navigate = useNavigate();
  const tab = search.tab ?? Runs;
  const page = search.page ?? 1;
  const [isCreating, setIsCreating] = useState(false);
  const casesCount = useTestCases(tab === Cases ? page : 1).data?.totalRecords;

  const goTo = (next: Schemas.TestsPageSearch) =>
    void navigate({ to: "/tests", search: Schemas.ZTestsPageSearch.parse(next) });
  const onPage = (nextPage: number) =>
    goTo({ ...search, page: nextPage === 1 ? undefined : nextPage });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tests"
        description="Run against your staging environment before a configuration goes live"
      >
        <Button variant="outline" onClick={() => setIsCreating(true)}>
          <Plus aria-hidden />
          New case
        </Button>
      </PageHeader>

      <TestsSummary />

      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={tab}
        onValueChange={(value) => {
          const next = Schemas.ZTestsPageTab.safeParse(value);
          if (next.success) goTo({ tab: next.data === Runs ? undefined : next.data });
        }}
        aria-label="Show"
        className="self-start"
      >
        <ToggleGroupItem value={Runs} className="px-3">
          Runs
        </ToggleGroupItem>
        <ToggleGroupItem value={Cases} className="gap-1.5 px-3">
          Cases
          {casesCount !== undefined && (
            <span className="text-muted-foreground">{Utilities.formatCount(casesCount)}</span>
          )}
        </ToggleGroupItem>
      </ToggleGroup>

      {tab === Runs ? (
        <TestRuns page={page} onPage={onPage} />
      ) : (
        <TestCases page={page} onPage={onPage} />
      )}

      <NewTestCaseDialog open={isCreating} onClose={() => setIsCreating(false)} />
    </div>
  );
}

// DEV_NOTE: Test cases, the live config's and the draft's latest result, and where the tests run (the default chatbot)
function TestsSummary() {
  const query = useTestsSummary();
  const summary = query.data?.summary;
  if (query.isPending) return <Skeleton className="h-28 rounded-xl" aria-label="Loading" />;
  if (!summary) {
    return <PageError title="The summary didn't load" onRetry={() => void query.refetch()} />;
  }
  return <TestsSummaryStrip summary={summary} />;
}

function TestsSummaryStrip({ summary }: Schemas.DashboardTestsSummaryProps) {
  const configCell = (
    kind: "Live" | "Draft",
    config: Schemas.EvalRunsSummaryConfig | null,
    emptyNote: string,
  ) => {
    if (config === null) return <MetricCell label={kind} value="—" note={emptyNote} />;
    const label = `${kind} v${config.configVersion}`;
    if (config.run === null) return <MetricCell label={label} value="Not tested" />;
    const { note, tone } = configNote(config.run);
    return (
      <MetricCell label={label} value={runResult(config.run).label} note={note} noteTone={tone} />
    );
  };

  return (
    <MetricStrip>
      <MetricCell
        label="Test cases"
        value={Utilities.formatCount(summary.caseCount)}
        note={Utilities.plural(summary.safetyCaseCount, "safety case")}
      />
      {configCell("Live", summary.live, "Nothing published yet")}
      {configCell("Draft", summary.draft, "No draft in progress")}
      {summary.staging ? (
        <MetricCell label="Runs on" value="Staging" note={summary.staging.host} />
      ) : (
        <MetricCell
          label="Runs on"
          value="Not set up"
          note="Add a staging connection in Settings"
          noteTone={Schemas.DashboardToneEnum.Negative}
        />
      )}
    </MetricStrip>
  );
}

function TestRuns({ page, onPage }: Schemas.DashboardTestRunsProps) {
  const query = useTestRuns(page);
  const runs = query.data?.evalRuns;

  if (query.isPending) return <Skeleton className="h-48 rounded-xl" aria-label="Loading" />;
  if (!runs) return <PageError title="Runs didn't load" onRetry={() => void query.refetch()} />;
  if (runs.length === 0 && page === 1) {
    return (
      <EmptyBox text="No test runs yet. Runs show up here once tests run against your staging environment." />
    );
  }

  return (
    <div
      aria-busy={query.isPlaceholderData}
      className={cn(
        "flex flex-col gap-3 transition-opacity",
        query.isPlaceholderData && "pointer-events-none opacity-50",
      )}
    >
      <div className="overflow-x-auto rounded-xl border">
        <Table aria-label="Runs">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">Trigger</TableHead>
              <TableHead className="px-4">Config</TableHead>
              <TableHead className="px-4">Cases</TableHead>
              <TableHead className="px-4">Safety</TableHead>
              <TableHead className="px-4">Result</TableHead>
              <TableHead className="px-4 text-right">Cost</TableHead>
              <TableHead className="px-4">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TestRunRow key={run.publicId} evalRun={run} />
            ))}
          </TableBody>
        </Table>
      </div>
      {runs.length === 0 && (
        <p className="text-body text-muted-foreground">Nothing on this page.</p>
      )}
      <Pager
        page={page}
        pageSize={Schemas.EVAL_RUNS_PAGE_SIZE}
        totalRecords={query.data?.totalRecords ?? 0}
        onPage={onPage}
      />
    </div>
  );
}

function TestRunRow({ evalRun }: Schemas.DashboardTestRunRowProps) {
  return (
    <TableRow className="relative">
      <TableCell className="px-4 py-3">
        <Link
          to="/tests/$id"
          params={{ id: evalRun.publicId }}
          className="font-medium text-foreground after:absolute after:inset-0 hover:text-brand-text"
        >
          {TRIGGER_TEXT[evalRun.trigger]}
        </Link>
      </TableCell>
      <TableCell className="px-4 py-3">
        <span className="font-mono text-mono-value text-subtle-foreground">
          {configText(evalRun.config)}
        </span>
        {evalRun.config.chatbotName && (
          <span className="ml-2 text-caption text-muted-foreground">
            {evalRun.config.chatbotName}
          </span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 tabular-nums">{casesText(evalRun)}</TableCell>
      <TableCell className="px-4 py-3 tabular-nums">{safetyText(evalRun)}</TableCell>
      <TableCell className="px-4 py-3">
        <RunResultChip evalRun={evalRun} />
      </TableCell>
      <TableCell className="px-4 py-3 text-right tabular-nums">
        {costText(evalRun.costUsd)}
      </TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">
        {Utilities.formatWhenWithTime(evalRun.createdAt)}
      </TableCell>
    </TableRow>
  );
}

function TestCases({ page, onPage }: Schemas.DashboardTestCasesProps) {
  const query = useTestCases(page);
  const cases = query.data?.evalCases;

  if (query.isPending) return <Skeleton className="h-48 rounded-xl" aria-label="Loading" />;
  if (!cases) return <PageError title="Cases didn't load" onRetry={() => void query.refetch()} />;
  if (cases.length === 0 && page === 1) {
    return (
      <EmptyBox text="No test cases yet. Write one with New case, or turn a quality issue into one." />
    );
  }

  return (
    <div
      aria-busy={query.isPlaceholderData}
      className={cn(
        "flex flex-col gap-3 transition-opacity",
        query.isPlaceholderData && "pointer-events-none opacity-50",
      )}
    >
      <div className="overflow-x-auto rounded-xl border">
        <Table aria-label="Cases">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-4">Case</TableHead>
              <TableHead className="px-4">Chatbot</TableHead>
              <TableHead className="px-4">Last result</TableHead>
              <TableHead className="w-12 px-2">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {cases.map((evalCase) => (
              <TestCaseRow key={evalCase.publicId} evalCase={evalCase} />
            ))}
          </TableBody>
        </Table>
      </div>
      {cases.length === 0 && (
        <p className="text-body text-muted-foreground">Nothing on this page.</p>
      )}
      <Pager
        page={page}
        pageSize={Schemas.EVAL_CASES_PAGE_SIZE}
        totalRecords={query.data?.totalRecords ?? 0}
        onPage={onPage}
      />
    </div>
  );
}

// DEV_NOTE: One case: name with its chips (safety, the platform's own, off), its chatbot (every chatbot for a platform
// case), its newest result linked to its attempts in that run, and for the company's own cases Edit / Turn off / Turn on
function TestCaseRow({ evalCase }: Schemas.DashboardTestCaseRowProps) {
  const update = useUpdateTestCase(evalCase.publicId);
  const [isEditing, setIsEditing] = useState(false);
  const { latestResult } = evalCase;

  return (
    <TableRow className={cn(!evalCase.isActive && "text-muted-foreground")}>
      <TableCell className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "font-medium",
              evalCase.isActive ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {evalCase.name}
          </span>
          {evalCase.isSafety && <StatusChip label="Safety" tone={Tone.Neutral} />}
          {evalCase.isPlatform && <StatusChip label="Platform" tone={Tone.Brand} />}
          {!evalCase.isActive && <StatusChip label="Off" tone={Tone.Neutral} />}
        </div>
      </TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">
        {evalCase.isPlatform ? "Every chatbot" : (evalCase.chatbotName ?? "Removed chatbot")}
      </TableCell>
      <TableCell className="px-4 py-3">
        {latestResult ? (
          <Link
            to="/tests/$id"
            params={{ id: latestResult.evalRunPublicId }}
            search={{ caseId: evalCase.publicId }}
            className="inline-flex items-center gap-2 text-subtle-foreground hover:text-foreground"
          >
            <CaseResultChip hasPassed={latestResult.hasPassed} />
            <span className="text-caption">{Utilities.formatWhen(latestResult.createdAt)}</span>
          </Link>
        ) : (
          <span className="text-caption text-muted-foreground">Not run yet</span>
        )}
      </TableCell>
      <TableCell className="px-2 py-1.5">
        {!evalCase.isPlatform && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-subtle-foreground"
                aria-label={`Actions for ${evalCase.name}`}
              >
                <DotsThree />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={update.isPending} onSelect={() => setIsEditing(true)}>
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={update.isPending}
                onSelect={() => update.mutate({ isActive: !evalCase.isActive })}
              >
                {evalCase.isActive ? "Turn off" : "Turn on"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {isEditing && (
          <TestCaseEditDialog publicId={evalCase.publicId} onClose={() => setIsEditing(false)} />
        )}
      </TableCell>
    </TableRow>
  );
}

const CASE_FORM_DESCRIPTION =
  "Write the conversation up to the question to test, and what a good reply does. Tests run against your staging environment.";

// DEV_NOTE: New case, for the default chatbot; the form mounts fresh each time the dialog opens
function NewTestCaseDialog({ open, onClose }: Schemas.DashboardNewTestCaseDialogProps) {
  const create = useCreateTestCase();
  const save = async (value: Schemas.EvalCaseDraft) => {
    await create.mutateAsync(value);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {open && (
          <EvalCaseForm
            defaultValues={EMPTY_CASE}
            canEditMessages
            title="New case"
            description={CASE_FORM_DESCRIPTION}
            submitLabel="Save case"
            onSubmit={save}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// DEV_NOTE: Edit loads the case's conversation, rubric and other checks first
function TestCaseEditDialog({ publicId, onClose }: Schemas.DashboardTestCaseEditDialogProps) {
  const query = useTestCase(publicId);
  const evalCase = query.data?.evalCase;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {evalCase ? (
          <TestCaseEditForm evalCase={evalCase} onClose={onClose} />
        ) : (
          <>
            <DialogTitle>Edit case</DialogTitle>
            {query.isPending ? (
              <Skeleton className="h-48 rounded-lg" aria-label="Loading" />
            ) : (
              <PageError title="The case didn't load" onRetry={() => void query.refetch()} />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// DEV_NOTE: The edit form (the conversation can grow or shrink); a case stored in a shape this page can't edit offers
// only Turn off / Turn on
function TestCaseEditForm({ evalCase, onClose }: Schemas.DashboardTestCaseEditFormProps) {
  const update = useUpdateTestCase(evalCase.publicId);
  const { body } = evalCase;

  if (body === null) {
    return (
      <div className="flex flex-col gap-5">
        <DialogHeader>
          <DialogTitle>Edit case</DialogTitle>
          <DialogDescription>
            This case's conversation can't be edited here. You can still turn it on or off.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={update.isPending}
            onClick={() =>
              update
                .mutateAsync({ isActive: !evalCase.isActive })
                .then(onClose)
                .catch(() => undefined)
            }
          >
            {evalCase.isActive ? "Turn off" : "Turn on"}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  // DEV_NOTE: A blank rubric is allowed only beside other checks (the form checks it): sent as null, no judge
  const save = async (value: Schemas.EvalCaseDraft) => {
    await update.mutateAsync({
      ...value,
      rubric: value.rubric.trim() === "" ? null : value.rubric,
    });
    onClose();
  };
  return (
    <EvalCaseForm
      defaultValues={{ name: evalCase.name, messages: body.messages, rubric: body.rubric ?? "" }}
      checks={body.checks}
      canEditMessages
      title="Edit case"
      description={CASE_FORM_DESCRIPTION}
      submitLabel="Save case"
      onSubmit={save}
      onCancel={onClose}
    />
  );
}

// DEV_NOTE: /tests/$id: one run's header and strip, its cases (failed first) in 2 columns, and the open case's attempts
// in the third at ≥1100px (DESIGN.md §6)
export function TestRunPage({ publicId, search }: Schemas.DashboardTestRunPageProps) {
  const navigate = useNavigate();
  const query = useTestRun(publicId);
  const evalRun = query.data?.evalRun;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-12 w-64 rounded-md" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }
  if (!evalRun) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Test run" description="One run of the tests against staging" />
        {isNotFound ? (
          <EmptyBox text="This run isn't available. It may have been removed." />
        ) : (
          <PageError title="The run didn't load" onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }

  const chatbot = evalRun.config.chatbotName ? `${evalRun.config.chatbotName} ` : "";
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={TRIGGER_TEXT[evalRun.trigger]}
        description={`${chatbot}${configText(evalRun.config)}, ${Utilities.formatWhenWithTime(evalRun.createdAt)}`}
      >
        <Button variant="outline" asChild>
          <Link to="/tests">All runs</Link>
        </Button>
      </PageHeader>

      <MetricStrip>
        <MetricCell label="Result" value={runResult(evalRun).label} />
        <MetricCell label="Cases passed" value={casesText(evalRun)} />
        <MetricCell label="Safety cases" value={safetyText(evalRun)} />
        <MetricCell
          label="Cost"
          value={costText(evalRun.costUsd)}
          note={`${Utilities.plural(evalRun.k, "attempt")} per case`}
        />
      </MetricStrip>

      <div className="grid items-start gap-6 min-[1100px]:grid-cols-3">
        <div
          className={cn(
            "min-w-0",
            search.caseId ? "min-[1100px]:col-span-2" : "min-[1100px]:col-span-3",
          )}
        >
          <TestRunCases
            publicId={publicId}
            search={search}
            onPage={(page) =>
              void navigate({
                to: "/tests/$id",
                params: { id: publicId },
                search: Schemas.ZTestRunPageSearch.parse({
                  ...search,
                  page: page === 1 ? undefined : page,
                }),
              })
            }
          />
        </div>
        {search.caseId && (
          <TestRunCaseCard runPublicId={publicId} casePublicId={search.caseId} search={search} />
        )}
      </div>
    </div>
  );
}

function TestRunCases({ publicId, search, onPage }: Schemas.DashboardTestRunCasesProps) {
  const page = search.page ?? 1;
  const query = useTestRunCases(publicId, page);
  const cases = query.data?.cases;

  if (query.isPending) return <Skeleton className="h-48 rounded-xl" aria-label="Loading" />;
  if (!cases) return <PageError title="Cases didn't load" onRetry={() => void query.refetch()} />;
  if (cases.length === 0 && page === 1) {
    return <EmptyBox text="No results yet. Cases show up here as the run grades them." />;
  }

  return (
    <div
      aria-busy={query.isPlaceholderData}
      className={cn(
        "flex flex-col gap-3 transition-opacity",
        query.isPlaceholderData && "pointer-events-none opacity-50",
      )}
    >
      <ul className="divide-y overflow-hidden rounded-xl border" aria-label="Cases">
        {cases.map((runCase) => (
          <TestRunCaseRow
            key={runCase.evalCase.publicId}
            runPublicId={publicId}
            runCase={runCase}
            search={search}
            isSelected={runCase.evalCase.publicId === search.caseId}
          />
        ))}
      </ul>
      {cases.length === 0 && (
        <p className="text-body text-muted-foreground">Nothing on this page.</p>
      )}
      <Pager
        page={page}
        pageSize={Schemas.EVAL_RUN_CASES_PAGE_SIZE}
        totalRecords={query.data?.totalRecords ?? 0}
        onPage={onPage}
      />
    </div>
  );
}

function TestRunCaseRow({
  runPublicId,
  runCase,
  search,
  isSelected,
}: Schemas.DashboardTestRunCaseRowProps) {
  const { evalCase } = runCase;
  return (
    <li
      className={cn(
        "relative flex items-center justify-between gap-3 px-[22px] py-4",
        isSelected && "bg-surface-subtle",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/tests/$id"
            params={{ id: runPublicId }}
            search={{ ...search, caseId: evalCase.publicId }}
            className="text-body font-medium break-words text-foreground after:absolute after:inset-0"
            aria-current={isSelected ? "true" : undefined}
          >
            {evalCase.name}
          </Link>
          {evalCase.isSafety && <StatusChip label="Safety" tone={Tone.Neutral} />}
          {evalCase.isPlatform && <StatusChip label="Platform" tone={Tone.Brand} />}
        </div>
        <p className="text-caption text-muted-foreground">
          Passed {runCase.passedAttemptCount} of {Utilities.plural(runCase.attemptCount, "attempt")}
        </p>
      </div>
      <CaseResultChip hasPassed={runCase.hasPassed} />
    </li>
  );
}

// DEV_NOTE: The case's detail card (DESIGN.md dashboard-Tests): result and safety chips, its attempts with what each
// check found, and View transcript per attempt
function TestRunCaseCard({
  runPublicId,
  casePublicId,
  search,
}: Schemas.DashboardTestRunCaseCardProps) {
  const query = useTestRunCase(runPublicId, casePublicId);
  const runQuery = useTestRun(runPublicId);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const runCase = query.data?.runCase;
  const attempts = query.data?.attempts ?? [];
  const evalRun = runQuery.data?.evalRun;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <Card className="relative gap-0 py-0" role="region" aria-label="Case">
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-4 right-4 text-subtle-foreground"
        asChild
      >
        <Link
          to="/tests/$id"
          params={{ id: runPublicId }}
          search={{ ...search, caseId: undefined }}
          aria-label="Close"
        >
          <X />
        </Link>
      </Button>
      {query.isPending && (
        <div className="flex flex-col gap-3 px-[22px] py-5" aria-busy="true" aria-label="Loading">
          <Skeleton className="h-6 w-32 rounded-md" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      )}
      {!query.isPending && !runCase && (
        <div className="px-[22px] py-5 pr-14">
          {isNotFound ? (
            <p className="text-body text-muted-foreground">This case isn't part of this run.</p>
          ) : (
            <PageError title="The case didn't load" onRetry={() => void query.refetch()} />
          )}
        </div>
      )}
      {runCase && (
        <>
          <div className="flex flex-col items-start gap-1.5 px-[22px] pt-5 pr-14 pb-4">
            <div className="flex flex-wrap gap-2">
              <CaseResultChip hasPassed={runCase.hasPassed} />
              {runCase.evalCase.isSafety && <StatusChip label="Safety" tone={Tone.Neutral} />}
            </div>
            <h2 className="text-section break-words text-foreground">{runCase.evalCase.name}</h2>
            <p className="text-caption text-muted-foreground">
              {evalRun ? `${configText(evalRun.config)}, ` : ""}
              {caseResultText(runCase, query.data?.k ?? runCase.attemptCount)}
            </p>
          </div>
          {attempts.map((attempt) => (
            <TestAttempt
              key={attempt.attempt}
              attempt={attempt}
              onViewTranscript={setTranscriptId}
            />
          ))}
          {runCase.evalCase.isSafety && runCase.hasPassed === false && (
            <p className="mx-[22px] mb-5 rounded-lg bg-destructive-soft px-3.5 py-3 text-body text-foreground">
              A failed safety case blocks publishing, even above the pass threshold.
            </p>
          )}
        </>
      )}
      <TestTranscriptSheet
        runPublicId={runPublicId}
        filePublicId={transcriptId}
        onClose={() => setTranscriptId(null)}
      />
    </Card>
  );
}

function TestAttempt({ attempt, onViewTranscript }: Schemas.DashboardTestAttemptProps) {
  const { grader, transcriptFilePublicId } = attempt;
  const checkKeys = contentKeys(grader?.checks ?? [], (check) => `${check.kind}:${check.label}`);
  return (
    <section
      className="flex flex-col gap-3 border-t px-[22px] py-4"
      aria-label={`Attempt ${attempt.attempt}`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-body font-medium text-foreground">Attempt {attempt.attempt}</p>
        <StatusChip
          label={attempt.hasPassed ? "Passed" : "Failed"}
          tone={attempt.hasPassed ? Tone.Success : Tone.Destructive}
        />
      </div>
      {attempt.isGraderOutputUnreadable && (
        <p className="text-body text-muted-foreground">The grader's output can't be read.</p>
      )}
      {!grader && !attempt.isGraderOutputUnreadable && (
        <p className="text-body text-muted-foreground">No checks recorded.</p>
      )}
      {grader && grader.checks.length > 0 && (
        <ul className="flex flex-col gap-3">
          {grader.checks.map((check, index) => (
            <li key={checkKeys[index]} className="flex gap-2.5">
              {check.hasPassed ? (
                <Check className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passed" />
              ) : (
                <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Failed" />
              )}
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="text-body break-words text-foreground">{check.label}</p>
                {check.detail && (
                  <p className="text-caption break-words text-muted-foreground">{check.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {grader?.error && (
        <p className="text-body break-words text-destructive">Grading stopped: {grader.error}</p>
      )}
      {transcriptFilePublicId && (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => onViewTranscript(transcriptFilePublicId)}
        >
          <FileText aria-hidden />
          View transcript
        </Button>
      )}
    </section>
  );
}

// DEV_NOTE: An attempt's transcript, read from R2 by the backend and shown in a sheet like the Conversations transcript
function TestTranscriptSheet({
  runPublicId,
  filePublicId,
  onClose,
}: Schemas.DashboardTestTranscriptSheetProps) {
  const query = useTestTranscript(runPublicId, filePublicId);
  const entries = query.data?.transcript?.entries;
  const entryKeys = contentKeys(entries ?? [], entryText);
  const status = query.error instanceof ApiError ? query.error.status : null;

  return (
    <Sheet open={filePublicId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Transcript</SheetTitle>
          <SheetDescription>What the chatbot did and said in this attempt</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6">
          {query.isPending && filePublicId !== null && (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
              <Skeleton className="h-12 rounded-lg" />
              <Skeleton className="h-12 rounded-lg" />
            </div>
          )}
          {status === 404 && (
            <p className="text-body text-muted-foreground">
              This transcript isn't available. It may have been deleted.
            </p>
          )}
          {status === 422 && (
            <p className="text-body text-muted-foreground">This transcript can't be read.</p>
          )}
          {query.isError && status !== 404 && status !== 422 && (
            <PageError title="The transcript didn't load" onRetry={() => void query.refetch()} />
          )}
          {entries?.length === 0 && (
            <p className="text-body text-muted-foreground">Nothing was said in this attempt.</p>
          )}
          {entries?.map((entry, index) => (
            <TestTranscriptEntry key={entryKeys[index]} entry={entry} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TestTranscriptEntry({ entry }: Schemas.DashboardTestTranscriptEntryProps) {
  if (entry.kind === Schemas.EvalTranscriptEntryKindEnum.Message) {
    return (
      <p className="text-body break-words whitespace-pre-wrap text-foreground">
        <span className="font-medium">
          {entry.role === Schemas.EvalCaseMessageRoleEnum.User ? "User" : "Assistant"}
        </span>{" "}
        {entry.text}
      </p>
    );
  }
  const tone =
    entry.toolCallStatus === Schemas.ToolCallStatusIntEnum.Ok
      ? Tone.Success
      : entry.toolCallStatus === Schemas.ToolCallStatusIntEnum.Blocked
        ? Tone.Warning
        : Tone.Destructive;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-subtle px-3 py-2.5">
      <p className="flex min-w-0 items-baseline gap-2">
        <span className="font-mono text-mono-value text-foreground">{entry.toolName}</span>
        <span className="font-mono text-mono-value text-muted-foreground">
          v{entry.toolVersion}
        </span>
        {entry.summary && (
          <span className="truncate text-caption text-muted-foreground">{entry.summary}</span>
        )}
      </p>
      <StatusChip label={entry.toolCallStatusLabel} tone={tone} />
    </div>
  );
}

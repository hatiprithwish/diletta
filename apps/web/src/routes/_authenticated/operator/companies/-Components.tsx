import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { ArrowSquareOut, ArrowsClockwise, Plus } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@app/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
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
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { Pager, PastEndNote } from "@/components/pager";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import {
  useCompanyStatusCounts,
  useCreateCompany,
  useOperatorCompanies,
  useOperatorCompany,
  useRebuildInsights,
  useSetCompanyStatus,
} from "./-data";
import { ConnectionsSection } from "./-Connections";
import { ToolsSection } from "./-Tools";

const { Active, Paused, Churned } = Schemas.CompanyStatusIntEnum;

export const COMPANY_STATUS_TONE: Record<
  Schemas.CompanyStatusIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Active]: Schemas.DashboardChipToneEnum.Success,
  [Paused]: Schemas.DashboardChipToneEnum.Warning,
  [Churned]: Schemas.DashboardChipToneEnum.Destructive,
};

const STATUS_TABS: { value: Schemas.OperatorCompanyStatusTabEnum; label: string }[] = [
  { value: Schemas.OperatorCompanyStatusTabEnum.All, label: "All" },
  { value: Schemas.OperatorCompanyStatusTabEnum.Active, label: "Active" },
  { value: Schemas.OperatorCompanyStatusTabEnum.Paused, label: "Paused" },
  { value: Schemas.OperatorCompanyStatusTabEnum.Churned, label: "Churned" },
];

// DEV_NOTE: created_at arrives as an ISO string; the shared type says Date
function createdWhen(company: Schemas.CompanyWithStatus) {
  return Utilities.formatWhen(new Date(company.createdAt).toISOString());
}

// DEV_NOTE: ADR 0006. Open a company's dashboard as its admin: the shell acts in the company ?company names. A churned
// company can't be opened (403), so its button is off.
function OpenDashboardButton({ company, variant }: Schemas.DashboardOpenDashboardButtonProps) {
  const isChurned = company.companyStatus === Churned;
  return (
    <Button
      variant={variant}
      size={variant === "outline" ? "sm" : "default"}
      disabled={isChurned}
      title={isChurned ? "A churned company's dashboard can't be opened" : undefined}
      asChild={!isChurned}
    >
      {isChurned ? (
        <span>
          <ArrowSquareOut aria-hidden />
          Open dashboard
        </span>
      ) : (
        <Link to="/overview" search={{ company: company.publicId }}>
          <ArrowSquareOut aria-hidden />
          Open dashboard
        </Link>
      )}
    </Button>
  );
}

// ─── Companies list

// DEV_NOTE: /operator/companies (M7-8 design, Companies): the status tabs with their counts, a page of companies, and
// New company
export function OperatorCompaniesPage({ search }: Schemas.DashboardOperatorCompaniesPageProps) {
  const navigate = useNavigate();
  const query = useOperatorCompanies(search);
  const counts = useCompanyStatusCounts().data?.counts;
  const [isCreating, setIsCreating] = useState(false);
  const isStale = query.isPlaceholderData;
  const tab = search.status ?? Schemas.OperatorCompanyStatusTabEnum.All;
  const page = search.page ?? 1;
  const companies = query.data?.companies;

  const tabCount = (value: Schemas.OperatorCompanyStatusTabEnum): number | null => {
    if (!counts) return null;
    const status = Schemas.OPERATOR_COMPANY_STATUS_TAB_MAP[value];
    return status === null ? counts[Active] + counts[Paused] + counts[Churned] : counts[status];
  };
  const goTo = (next: Schemas.OperatorCompaniesPageSearch) =>
    void navigate({
      to: "/operator/companies",
      search: Schemas.ZOperatorCompaniesPageSearch.parse(next),
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Companies"
        description="Every customer company. Set one up here, or open its dashboard to act as one of its admins."
      >
        <Button onClick={() => setIsCreating(true)}>
          <Plus aria-hidden />
          New company
        </Button>
      </PageHeader>

      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={tab}
        onValueChange={(value) => {
          const next = STATUS_TABS.find((item) => item.value === value);
          if (next) {
            goTo({
              status:
                next.value === Schemas.OperatorCompanyStatusTabEnum.All ? undefined : next.value,
            });
          }
        }}
        aria-label="Show"
        className="flex-wrap self-start"
      >
        {STATUS_TABS.map((item) => {
          const count = tabCount(item.value);
          return (
            <ToggleGroupItem key={item.value} value={item.value} className="gap-1.5 px-3">
              {item.label}
              {count !== null && (
                <span className="text-muted-foreground">{Utilities.formatCount(count)}</span>
              )}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>

      {query.isPending && <Skeleton className="h-48 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !companies && (
        <PageError title="Companies didn't load" onRetry={() => void query.refetch()} />
      )}
      {companies && companies.length === 0 && page === 1 && (
        <div className="rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            {tab === Schemas.OperatorCompanyStatusTabEnum.All
              ? "No companies yet. Create one, then add its connections."
              : "No companies with this status."}
          </p>
        </div>
      )}
      {companies && companies.length === 0 && page > 1 && (
        <PastEndNote
          pageSize={Schemas.OPERATOR_COMPANIES_PAGE_SIZE}
          totalRecords={tabCount(tab)}
          onPage={(next) => goTo({ ...search, page: next === 1 ? undefined : next })}
        />
      )}
      {companies && companies.length > 0 && (
        <div
          aria-busy={isStale}
          className={cn(
            "flex flex-col gap-4 transition-opacity",
            isStale && "pointer-events-none opacity-50",
          )}
        >
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Company</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Connections</TableHead>
                  <TableHead className="px-4">Created</TableHead>
                  <TableHead className="w-12 px-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.map((company) => (
                  <CompanyRow key={company.publicId} company={company} />
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager
            page={page}
            pageSize={Schemas.OPERATOR_COMPANIES_PAGE_SIZE}
            totalRecords={tabCount(tab)}
            rowCount={companies.length}
            onPage={(next) => goTo({ ...search, page: next === 1 ? undefined : next })}
          />
        </div>
      )}
      <NewCompanyDialog isOpen={isCreating} onClose={() => setIsCreating(false)} />
    </div>
  );
}

function CompanyRow({ company }: Schemas.DashboardOperatorCompanyRowProps) {
  return (
    <TableRow>
      <TableCell className="px-4 py-3">
        <Link
          to="/operator/companies/$id"
          params={{ id: company.publicId }}
          className="text-body font-medium text-foreground hover:underline"
        >
          {company.name}
        </Link>
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip
          label={company.companyStatusLabel}
          tone={COMPANY_STATUS_TONE[company.companyStatus]}
        />
      </TableCell>
      <TableCell className="px-4 py-3">
        {company.connectionEnvironmentLabels.length > 0 ? (
          <span className="text-subtle-foreground">
            {company.connectionEnvironmentLabels.join(", ")}
          </span>
        ) : (
          <span className="text-muted-foreground">None yet</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">{createdWhen(company)}</TableCell>
      <TableCell className="px-4 py-3 text-right">
        <OpenDashboardButton company={company} variant="outline" />
      </TableCell>
    </TableRow>
  );
}

function nameIssue(value: string): string | undefined {
  return Schemas.ZCompanyBase.shape.name.safeParse(value).success
    ? undefined
    : "Give the company a name.";
}

// DEV_NOTE: The form is mounted only while the dialog is open, so every opening starts empty. Awaits the write
// (mutateAsync) and opens the new company's page; the toast says why otherwise.
function NewCompanyDialog({ isOpen, onClose }: Schemas.DashboardDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {isOpen && <NewCompanyForm isOpen={isOpen} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function NewCompanyForm({ onClose }: Schemas.DashboardDialogProps) {
  const navigate = useNavigate();
  const create = useCreateCompany();
  const form = useForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      const created = await create.mutateAsync({ company: { name: value.name } });
      onClose();
      if (created.company) {
        void navigate({
          to: "/operator/companies/$id",
          params: { id: created.company.publicId },
        });
      }
    },
  });

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().catch(() => undefined);
      }}
    >
      <DialogHeader>
        <DialogTitle>New company</DialogTitle>
        <DialogDescription>
          It starts with no admins and no connections. Add its connections next, then open its
          dashboard to invite its first admin.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="name" validators={{ onChange: ({ value }) => nameIssue(value) }}>
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor="company-name">Name</FieldLabel>
            <Input
              id="company-name"
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
          </Field>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Creating…" : "Create company"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

// ─── One company

// DEV_NOTE: The sections of a company's page, in tab order; the first is the default
const COMPANY_TABS: { value: Schemas.OperatorCompanyTabEnum; label: string }[] = [
  { value: Schemas.OperatorCompanyTabEnum.Connections, label: "Connections" },
  { value: Schemas.OperatorCompanyTabEnum.Tools, label: "Tools" },
  { value: Schemas.OperatorCompanyTabEnum.Maintenance, label: "Maintenance" },
];

// DEV_NOTE: /operator/companies/$id (M7-8 design, Company): its header (status, public id, Open dashboard) and its
// sections, the one shown in the URL (?tab=)
export function OperatorCompanyPage({
  companyPublicId,
  search,
}: Schemas.DashboardOperatorCompanyPageProps) {
  const navigate = useNavigate();
  const query = useOperatorCompany(companyPublicId);
  const company = query.data?.company;
  const tab =
    COMPANY_TABS.find((item) => item.value === search.tab)?.value ?? COMPANY_TABS[0]!.value;

  if (query.isPending) return <Skeleton className="h-40 rounded-xl" aria-label="Loading" />;
  if (!company) {
    return <PageError title="This company didn't load" onRetry={() => void query.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-9">
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-page-title text-foreground">{company.name}</h1>
              <StatusChip
                label={company.companyStatusLabel}
                tone={COMPANY_STATUS_TONE[company.companyStatus]}
              />
            </div>
            <p className="text-body text-muted-foreground">
              Created {createdWhen(company)} ·{" "}
              <span className="font-mono text-mono-value text-subtle-foreground">
                {company.publicId}
              </span>
            </p>
          </div>
          <OpenDashboardButton company={company} variant="default" />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          spacing={0}
          value={tab}
          onValueChange={(value) => {
            const next = COMPANY_TABS.find((item) => item.value === value);
            if (next) {
              void navigate({
                to: "/operator/companies/$id",
                params: { id: companyPublicId },
                search: { tab: next.value === COMPANY_TABS[0]!.value ? undefined : next.value },
              });
            }
          }}
          aria-label="Company sections"
          className="flex-wrap self-start"
        >
          {COMPANY_TABS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} className="px-3">
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {tab === Schemas.OperatorCompanyTabEnum.Connections && (
        <ConnectionsSection company={company} />
      )}
      {tab === Schemas.OperatorCompanyTabEnum.Tools && (
        <ToolsSection
          company={company}
          search={search}
          onSearch={(next) =>
            void navigate({
              to: "/operator/companies/$id",
              params: { id: companyPublicId },
              search: Schemas.ZOperatorCompanyPageSearch.parse(next),
            })
          }
        />
      )}
      {tab === Schemas.OperatorCompanyTabEnum.Maintenance && (
        <MaintenanceSection company={company} />
      )}
    </div>
  );
}

// ─── Maintenance

function MaintenanceSection({ company }: Schemas.DashboardOperatorCompanySectionProps) {
  return (
    <div className="flex flex-col gap-10">
      <RebuildInsights company={company} />
      <CompanyStatusSection company={company} />
    </div>
  );
}

// DEV_NOTE: Defaults to the last 7 full UTC days; the request schema holds the rules (order, no future day, at most
// ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS), shown under the To field
function RebuildInsights({ company }: Schemas.DashboardOperatorCompanySectionProps) {
  const rebuild = useRebuildInsights(company.publicId);
  const [today] = useState(() => Schemas.activityRollupDayKey(Date.now()));
  const [range, setRange] = useState(() => ({
    fromDay: Schemas.activityRollupDayKey(Date.now() - 7 * 86_400_000),
    toDay: Schemas.activityRollupDayKey(Date.now() - 86_400_000),
  }));
  const parsed = Schemas.ZRebuildActivityRollupsApiRequest.safeParse(range);
  const issue = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Pick a range of days");
  const dayCount = parsed.success
    ? Schemas.activityRollupDayCount(range.fromDay, range.toDay)
    : null;

  return (
    <section className="flex flex-col gap-4" aria-label="Rebuild insights">
      <SectionHeader
        title="Rebuild insights"
        description="Recounts the daily numbers Overview, Usage and Impact show, for the days you pick. Use it after fixing data. The hourly run keeps today and yesterday up to date on its own."
      />
      <form
        className="flex flex-wrap items-end gap-3 rounded-xl border px-[22px] py-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.success) rebuild.mutate(parsed.data);
        }}
      >
        <Field className="min-w-44 flex-1">
          <FieldLabel htmlFor="rebuild-from">From</FieldLabel>
          <Input
            id="rebuild-from"
            type="date"
            max={today}
            value={range.fromDay}
            onChange={(event) =>
              setRange((current) => ({ ...current, fromDay: event.target.value }))
            }
          />
        </Field>
        <Field className="min-w-44 flex-1" data-invalid={issue !== null}>
          <FieldLabel htmlFor="rebuild-to">To</FieldLabel>
          <Input
            id="rebuild-to"
            type="date"
            max={today}
            value={range.toDay}
            onChange={(event) => setRange((current) => ({ ...current, toDay: event.target.value }))}
            aria-invalid={issue !== null}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={!parsed.success || rebuild.isPending}>
          <ArrowsClockwise aria-hidden />
          {rebuild.isPending
            ? "Rebuilding…"
            : dayCount === null
              ? "Rebuild"
              : `Rebuild ${Utilities.plural(dayCount, "day")}`}
        </Button>
      </form>
      <p className={cn("text-caption", issue ? "text-destructive" : "text-muted-foreground")}>
        {issue ?? `At most ${Schemas.ACTIVITY_ROLLUPS_MAX_REBUILD_DAYS} days at a time, in UTC.`}
      </p>
    </section>
  );
}

// DEV_NOTE: What each status move does, in the page's words (DESIGN.md §8). The moves offered depend on the current
// status: Active → Pause / Churn, Paused → Make active / Churn, Churned → Make active.
const STATUS_MOVES: Record<
  Schemas.CompanyStatusIntEnum,
  { title: string; description: string; action: string }
> = {
  [Active]: {
    title: "Make active",
    description: "Its chatbots answer again and its admins can sign in.",
    action: "Make active",
  },
  [Paused]: {
    title: "Pause",
    description:
      "Its chatbots stop answering and test runs are refused. Its admins keep the dashboard.",
    action: "Pause company",
  },
  [Churned]: {
    title: "Churn",
    description:
      "Everything a pause does, and nobody at the company can sign in. Nothing is deleted, and you can bring it back.",
    action: "Churn company",
  },
};

function CompanyStatusSection({ company }: Schemas.DashboardOperatorCompanySectionProps) {
  const [moving, setMoving] = useState<Schemas.CompanyStatusIntEnum | null>(null);
  const moves = [Active, Paused, Churned].filter(
    (status) =>
      status !== company.companyStatus && !(company.companyStatus === Churned && status === Paused),
  );

  return (
    <section className="flex flex-col gap-4" aria-label="Company status">
      <SectionHeader
        title="Company status"
        description="Each change is recorded in the company's audit log as Diletta support."
      />
      <div className="rounded-xl border">
        {moves.map((status, index) => (
          <div
            key={status}
            className={cn(
              "flex flex-wrap items-center justify-between gap-4 px-[22px] py-[18px]",
              index > 0 && "border-t",
            )}
          >
            <div className="flex max-w-2xl flex-col gap-0.5">
              <span className="text-body font-medium text-foreground">
                {STATUS_MOVES[status].title}
              </span>
              <span className="text-caption text-muted-foreground">
                {STATUS_MOVES[status].description}
              </span>
            </div>
            <Button
              variant="outline"
              className={cn(status === Churned && "text-destructive hover:text-destructive")}
              onClick={() => setMoving(status)}
            >
              {STATUS_MOVES[status].action}
            </Button>
          </div>
        ))}
      </div>
      {moving !== null && (
        <StatusDialog
          company={company}
          status={moving}
          isOpen={moving !== null}
          onClose={() => setMoving(null)}
        />
      )}
    </section>
  );
}

// DEV_NOTE: Confirms a status move. Churning asks for the company's name first (it locks its admins out).
function StatusDialog({
  company,
  status,
  isOpen,
  onClose,
}: Schemas.DashboardOperatorStatusDialogProps) {
  const setStatus = useSetCompanyStatus(company.publicId);
  const [typedName, setTypedName] = useState("");
  const isChurn = status === Churned;
  const canConfirm = !isChurn || typedName.trim() === company.name;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canConfirm) return;
            void setStatus
              .mutateAsync({ company: { status } })
              .then(onClose)
              .catch(() => undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {STATUS_MOVES[status].title} {company.name}?
            </DialogTitle>
            <DialogDescription>
              {STATUS_MOVES[status].description} It takes effect from their next request.
            </DialogDescription>
          </DialogHeader>
          {isChurn && (
            <Field>
              <FieldLabel htmlFor="confirm-company-name">
                Type the company's name to confirm
              </FieldLabel>
              <Input
                id="confirm-company-name"
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                autoComplete="off"
              />
            </Field>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={isChurn ? "destructive" : "default"}
              disabled={!canConfirm || setStatus.isPending}
            >
              {setStatus.isPending ? "Saving…" : STATUS_MOVES[status].action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

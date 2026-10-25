import { useState } from "react";
import type { PropsWithChildren } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { ArrowsClockwise, DownloadSimple, PencilSimple } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@app/ui/components/alert-dialog";
import { Button } from "@app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@app/ui/components/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@app/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@app/ui/components/select";
import { Skeleton } from "@app/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@app/ui/components/table";
import { Textarea } from "@app/ui/components/textarea";
import { cn } from "@app/ui/lib/utils";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { Pager } from "@/components/pager";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import {
  useAuditLog,
  useAuditLogCount,
  useContentRetention,
  useEncryptionKeys,
  useExportAuditLog,
  useInjectionEvents,
  useInjectionEventsCount,
  useRotateEncryptionKey,
  useSecurityConnections,
  useUpdateAllowedOrigins,
  useUpdateContentRetention,
} from "./-data";

const KEY_STATUS_TONE: Record<
  Schemas.CompanyEncryptionKeyStatusIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Schemas.CompanyEncryptionKeyStatusIntEnum.Active]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.CompanyEncryptionKeyStatusIntEnum.Retiring]: Schemas.DashboardChipToneEnum.Warning,
  [Schemas.CompanyEncryptionKeyStatusIntEnum.Destroyed]: Schemas.DashboardChipToneEnum.Neutral,
};

const INJECTION_STATUS_TONE: Record<
  Schemas.QualityIssueStatusIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Schemas.QualityIssueStatusIntEnum.Open]: Schemas.DashboardChipToneEnum.Warning,
  [Schemas.QualityIssueStatusIntEnum.Fixed]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.QualityIssueStatusIntEnum.Dismissed]: Schemas.DashboardChipToneEnum.Neutral,
  [Schemas.QualityIssueStatusIntEnum.Converted]: Schemas.DashboardChipToneEnum.Brand,
};

const RETENTION_OPTIONS = Schemas.CONTENT_RETENTION_DAYS_OPTIONS.map((days) => ({
  value: String(days),
  label: `${days} days`,
}));

// DEV_NOTE: A box under a section header: a short line of text, no table
function SectionNote({ children }: PropsWithChildren) {
  return (
    <div className="rounded-xl border px-[22px] py-5">
      <p className="text-body text-muted-foreground">{children}</p>
    </div>
  );
}

// DEV_NOTE: The whole /security body (DESIGN.md dashboard-Security). Erase a user is left out until erasure is built
// end to end (M6-2).
export function SecurityPage({ search }: Schemas.DashboardSecurityPageProps) {
  const navigate = useNavigate();
  const goTo = (next: Schemas.SecurityPageSearch) =>
    void navigate({ to: "/security", search: Schemas.ZSecurityPageSearch.parse(next) });

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Security"
        description="Identity, encryption, data retention and the audit trail"
      />
      <IdentityAndOrigins />
      <EncryptionKeys />
      <Retention />
      <InjectionEvents
        page={search.injectionPage ?? 1}
        onPage={(page) => goTo({ ...search, injectionPage: page === 1 ? undefined : page })}
      />
      <AuditLog
        page={search.auditPage ?? 1}
        onPage={(page) => goTo({ ...search, auditPage: page === 1 ? undefined : page })}
      />
    </div>
  );
}

// ─── Identity and origins

function IdentityAndOrigins() {
  const query = useSecurityConnections();
  const connections = query.data?.connections;

  return (
    <section className="flex flex-col gap-4" aria-label="Identity and origins">
      <SectionHeader
        title="Identity and origins"
        description="How the widget proves who the user is, and where it can run."
      />
      {query.isPending && <Skeleton className="h-40 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !connections && (
        <PageError title="Identity settings didn't load" onRetry={() => void query.refetch()} />
      )}
      {connections && connections.length === 0 && (
        <SectionNote>
          No connection yet. Your Diletta contact sets it up with your app's sign-in details.
        </SectionNote>
      )}
      {connections?.map((connection) => (
        <ConnectionCard key={connection.publicId} connection={connection} />
      ))}
    </section>
  );
}

function ConnectionRow({ label, children }: PropsWithChildren<Schemas.DashboardSecurityRowProps>) {
  return (
    <div className="flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:gap-6">
      <dt className="w-40 shrink-0 text-body text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  );
}

function ConnectionCard({ connection }: Schemas.DashboardSecurityConnectionProps) {
  const [isEditing, setIsEditing] = useState(false);
  const isStaging = connection.environment === Schemas.CompanyConnectionEnvironmentIntEnum.Staging;

  return (
    <div className="flex flex-col rounded-xl border px-[22px] py-2">
      <div className="flex items-center justify-between gap-3 border-b py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-body font-medium text-foreground">{connection.environmentLabel}</h3>
          {connection.status !== Schemas.CompanyConnectionStatusIntEnum.Active && (
            <StatusChip
              label={connection.statusLabel}
              tone={Schemas.DashboardChipToneEnum.Neutral}
            />
          )}
        </div>
        <Button variant="outline" onClick={() => setIsEditing(true)}>
          <PencilSimple aria-hidden />
          Edit
        </Button>
      </div>
      <dl>
        <ConnectionRow label="JWT issuer">
          <span className="font-mono text-mono-value break-all text-foreground">
            {connection.jwtIssuer}
          </span>
        </ConnectionRow>
        <ConnectionRow label="Signing keys">
          {connection.signingKeysFetchedAt === null
            ? "Fetched from the issuer when a user next signs in."
            : `Fetched from the issuer, cached. Last refreshed ${Utilities.formatWhenWithTime(connection.signingKeysFetchedAt).toLowerCase()}`}
        </ConnectionRow>
        <ConnectionRow label="Allowed origins">
          <ul className="flex flex-wrap gap-2" aria-label="Allowed origins">
            {connection.allowedOrigins.map((origin) => (
              <li
                key={origin}
                className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-mono-value text-subtle-foreground"
              >
                {origin.replace(/^https:\/\//, "")}
              </li>
            ))}
          </ul>
        </ConnectionRow>
        {isStaging && (
          <ConnectionRow label="Used by">Test runs only, never your live users.</ConnectionRow>
        )}
      </dl>
      <OriginsDialog
        connection={connection}
        isOpen={isEditing}
        onClose={() => setIsEditing(false)}
      />
    </div>
  );
}

function OriginsDialog({
  connection,
  isOpen,
  onClose,
}: Schemas.DashboardSecurityOriginsDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {isOpen && <OriginsForm connection={connection} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

// DEV_NOTE: One origin per line; blank lines are ignored. Checked with the API's own schema before it is sent.
function originsIssue(text: string): string | undefined {
  const parsed = Schemas.ZUpdateAllowedOriginsApiRequest.safeParse({
    allowedOrigins: toOrigins(text),
  });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

function toOrigins(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function OriginsForm({
  connection,
  onClose,
}: Pick<Schemas.DashboardSecurityOriginsDialogProps, "connection" | "onClose">) {
  const update = useUpdateAllowedOrigins(connection.publicId);
  const form = useForm({
    defaultValues: { origins: connection.allowedOrigins.join("\n") },
    onSubmit: async ({ value }) => {
      await update.mutateAsync({ allowedOrigins: toOrigins(value.origins) });
      onClose();
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
        <DialogTitle>Allowed origins · {connection.environmentLabel}</DialogTitle>
        <DialogDescription>
          The widget only opens on these sites. The sign-in issuer is set up with your Diletta
          contact.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="origins" validators={{ onChange: ({ value }) => originsIssue(value) }}>
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor="allowed-origins">Origins</FieldLabel>
            <Textarea
              id="allowed-origins"
              name={field.name}
              rows={5}
              className="font-mono text-mono-value"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            <FieldDescription>
              One per line, like https://app.example.com. No paths.
            </FieldDescription>
            <FieldError
              errors={field.state.meta.errors.map((message) => ({ message: String(message) }))}
            />
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
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

// ─── Encryption keys

function EncryptionKeys() {
  const query = useEncryptionKeys();
  const rotate = useRotateEncryptionKey();
  const [isConfirming, setIsConfirming] = useState(false);
  const keys = query.data?.encryptionKeys;
  const isRotationInProgress = query.data?.isRotationInProgress ?? false;

  return (
    <section className="flex flex-col gap-4" aria-label="Encryption keys">
      <SectionHeader
        title="Encryption keys"
        description="Your data is encrypted with a key unique to your company."
      >
        <Button
          variant="outline"
          disabled={!keys || isRotationInProgress || rotate.isPending}
          onClick={() => setIsConfirming(true)}
        >
          <ArrowsClockwise aria-hidden />
          Rotate key
        </Button>
      </SectionHeader>
      {query.isPending && <Skeleton className="h-32 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !keys && (
        <PageError title="Encryption keys didn't load" onRetry={() => void query.refetch()} />
      )}
      {keys && (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Key</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Created</TableHead>
                  <TableHead className="px-4">Rotated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.version}>
                    <TableCell className="px-4 py-3 font-mono text-mono-value text-foreground">
                      v{key.version}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <StatusChip label={key.statusLabel} tone={KEY_STATUS_TONE[key.status]} />
                    </TableCell>
                    <TableCell className="px-4 py-3 text-subtle-foreground">
                      {Utilities.formatDay(key.createdAt.slice(0, 10))}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-subtle-foreground">
                      {key.rotatedAt === null
                        ? "—"
                        : Utilities.formatDay(key.rotatedAt.slice(0, 10))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {isRotationInProgress && (
            <p className="text-caption text-muted-foreground">
              A rotation is in progress: your data is moving to the new key. You can rotate again
              once the old key is retired.
            </p>
          )}
        </>
      )}
      <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the encryption key?</AlertDialogTitle>
            <AlertDialogDescription>
              New data is encrypted with a new key right away. Data saved before stays readable with
              the old key until it moves to the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotate.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={rotate.isPending}
              onClick={(event) => {
                event.preventDefault();
                rotate.mutate(undefined, { onSettled: () => setIsConfirming(false) });
              }}
            >
              {rotate.isPending ? "Rotating…" : "Rotate key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// ─── Retention

function Retention() {
  const query = useContentRetention();
  const retention = query.data?.retention;

  return (
    <section className="flex flex-col gap-4" aria-label="Retention">
      <SectionHeader title="Retention" />
      {query.isPending && <Skeleton className="h-40 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !retention && (
        <PageError title="Retention didn't load" onRetry={() => void query.refetch()} />
      )}
      {retention && <RetentionForm key={retention.contentRetentionDays} retention={retention} />}
    </section>
  );
}

function RetentionForm({ retention }: Schemas.DashboardSecurityRetentionFormProps) {
  const update = useUpdateContentRetention();
  const form = useForm({
    defaultValues: { days: String(retention.contentRetentionDays) },
    onSubmit: async ({ value }) => {
      await update.mutateAsync({ contentRetentionDays: Number(value.days) });
    },
  });

  return (
    <form
      className="flex flex-col gap-4 rounded-xl border px-[22px] py-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().catch(() => undefined);
      }}
    >
      <form.Field name="days">
        {(field) => (
          <Field className="max-w-sm">
            <FieldLabel htmlFor="retention-days">Keep chat content for</FieldLabel>
            <Select value={field.state.value} onValueChange={field.handleChange}>
              <SelectTrigger id="retention-days" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETENTION_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Counted from a conversation's last message.
              {retention.isDefault && " This is the default until you choose."}
            </FieldDescription>
          </Field>
        )}
      </form.Field>
      <p className="text-caption text-muted-foreground">
        Model gateway logs are kept {Schemas.GATEWAY_LOG_RETENTION_DAYS} days. Transcripts past this
        period are deleted once automatic deletion is switched on; until then they're kept.
      </p>
      <form.Subscribe
        selector={(state) =>
          [
            state.values.days !== String(retention.contentRetentionDays),
            state.isSubmitting,
          ] as const
        }
      >
        {([isChanged, isSubmitting]) => (
          <div>
            <Button type="submit" variant="outline" disabled={!isChanged || isSubmitting}>
              {isSubmitting ? "Saving…" : "Save retention"}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}

// ─── Prompt-injection events

function InjectionEvents({ page, onPage }: Schemas.DashboardSecurityPagedSectionProps) {
  const query = useInjectionEvents(page);
  const counted = useInjectionEventsCount();
  const events = query.data?.injectionEvents;

  return (
    <section className="flex flex-col gap-4" aria-label="Prompt-injection events">
      <SectionHeader
        title="Prompt-injection events"
        description="Hidden instructions found in records, pages or files."
      />
      {query.isPending && <Skeleton className="h-32 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !events && (
        <PageError
          title="Prompt-injection events didn't load"
          onRetry={() => void query.refetch()}
        />
      )}
      {events && events.length === 0 && page === 1 && (
        <SectionNote>
          No prompt-injection events. An issue marked Prompt injection on the Quality page shows
          here.
        </SectionNote>
      )}
      {events && (events.length > 0 || page > 1) && (
        <div
          aria-busy={query.isPlaceholderData}
          className={cn(
            "flex flex-col gap-3 transition-opacity",
            query.isPlaceholderData && "pointer-events-none opacity-50",
          )}
        >
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Detected in</TableHead>
                  <TableHead className="px-4">Conversation</TableHead>
                  <TableHead className="px-4">Action taken</TableHead>
                  <TableHead className="px-4">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map((event) => (
                  <TableRow key={event.publicId}>
                    <TableCell className="max-w-80 px-4 py-3">
                      <Link
                        to="/quality/$id"
                        params={{ id: event.publicId }}
                        className="line-clamp-2 text-foreground hover:text-brand-text"
                      >
                        {event.detectedIn}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-64 px-4 py-3">
                      <Link
                        to="/conversations/$id"
                        params={{ id: event.conversationPublicId }}
                        className="truncate text-subtle-foreground hover:text-brand-text"
                      >
                        {event.conversationTitle ?? "Untitled conversation"}
                      </Link>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <StatusChip
                        label={event.actionLabel}
                        tone={INJECTION_STATUS_TONE[event.status]}
                      />
                    </TableCell>
                    <TableCell className="px-4 py-3 text-subtle-foreground">
                      {Utilities.formatWhenWithTime(event.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {events.length === 0 && (
            <p className="text-body text-muted-foreground">Nothing on this page.</p>
          )}
          <Pager
            page={page}
            pageSize={Schemas.INJECTION_EVENTS_PAGE_SIZE}
            totalRecords={counted.data?.totalRecords ?? 0}
            onPage={onPage}
          />
        </div>
      )}
    </section>
  );
}

// ─── Audit log

// DEV_NOTE: Audit rows carry no id (they are never addressed one by one), so a row is keyed by what it says, with a
// count for two rows that say the same
function entryKeys(entries: Schemas.AuditLogEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const text = `${entry.createdAt}:${entry.actorName ?? entry.actorTypeLabel}:${entry.action}:${entry.on ?? ""}`;
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return `${count}:${text}`;
  });
}

function AuditLog({ page, onPage }: Schemas.DashboardSecurityPagedSectionProps) {
  const query = useAuditLog(page);
  const counted = useAuditLogCount();
  const exportLog = useExportAuditLog();
  const entries = query.data?.auditLog;
  const keys = entryKeys(entries ?? []);

  return (
    <section className="flex flex-col gap-4" aria-label="Audit log">
      <SectionHeader title="Audit log" description="Every change an admin made, newest first.">
        <Button
          variant="outline"
          disabled={!entries || entries.length === 0 || exportLog.isPending}
          onClick={() => exportLog.mutate()}
        >
          <DownloadSimple aria-hidden />
          {exportLog.isPending ? "Exporting…" : "Export"}
        </Button>
      </SectionHeader>
      {query.isPending && <Skeleton className="h-48 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !entries && (
        <PageError title="The audit log didn't load" onRetry={() => void query.refetch()} />
      )}
      {entries && entries.length === 0 && page === 1 && (
        <SectionNote>No changes yet. Each change an admin makes is listed here.</SectionNote>
      )}
      {entries && (entries.length > 0 || page > 1) && (
        <div
          aria-busy={query.isPlaceholderData}
          className={cn(
            "flex flex-col gap-3 transition-opacity",
            query.isPlaceholderData && "pointer-events-none opacity-50",
          )}
        >
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Who</TableHead>
                  <TableHead className="px-4">Action</TableHead>
                  <TableHead className="px-4">On</TableHead>
                  <TableHead className="px-4">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry, index) => (
                  <TableRow key={keys[index]}>
                    <TableCell className="px-4 py-3 text-foreground">
                      {entry.actorName ?? entry.actorTypeLabel}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-foreground">{entry.action}</TableCell>
                    <TableCell className="max-w-64 truncate px-4 py-3 text-subtle-foreground">
                      {entry.on ?? "—"}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-subtle-foreground">
                      {Utilities.formatWhenWithTime(entry.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {entries.length === 0 && (
            <p className="text-body text-muted-foreground">Nothing on this page.</p>
          )}
          <Pager
            page={page}
            pageSize={Schemas.AUDIT_LOG_PAGE_SIZE}
            totalRecords={counted.data?.totalRecords ?? 0}
            onPage={onPage}
          />
        </div>
      )}
    </section>
  );
}

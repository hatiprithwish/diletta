import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  DotsThree,
  FileText,
  Plus,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import * as Schemas from "@app/schemas";
import { Alert, AlertAction, AlertDescription } from "@app/ui/components/alert";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@app/ui/components/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
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
import { ToggleGroup, ToggleGroupItem } from "@app/ui/components/toggle-group";
import { cn } from "@app/ui/lib/utils";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import { ApiError } from "@/providers/apiClient";
import Utilities from "@/utils";
import { useDebouncedValue } from "@/utils/useDebouncedValue";
import {
  useAnswerDocGapCluster,
  useCreateKnowledgeSource,
  useDeleteKnowledgeDocument,
  useDeleteKnowledgeSource,
  useDismissDocGapCluster,
  useDocGapClusters,
  useFailedKnowledgeSources,
  useKnowledgeDocuments,
  useKnowledgeDocumentsCount,
  useKnowledgeSource,
  useKnowledgeSourceChoices,
  useKnowledgeSources,
  useKnowledgeSourcesCount,
  useSyncKnowledgeSource,
  useUpdateKnowledgeSource,
  useUploadKnowledgeDocument,
} from "./-data";

const { Sitemap, Url, Upload } = Schemas.KnowledgeSourceTypeIntEnum;
const { Active, Syncing, Failed, Paused } = Schemas.KnowledgeSourceStatusIntEnum;
const UNTITLED_DOCUMENT = "Untitled document";
// DEV_NOTE: The file input's accept list: every extension an upload source takes
const UPLOAD_ACCEPT = Object.keys(Schemas.KNOWLEDGE_UPLOAD_MIME_BY_EXTENSION)
  .map((extension) => `.${extension}`)
  .join(",");
// DEV_NOTE: The document picker shows this many matches (it asks for one more, to know if there are others); more
// means "type more of the title"
const PICKER_PAGE_SIZE = 8;
// DEV_NOTE: How long a title search waits after the last keystroke before it asks the server
const SEARCH_DEBOUNCE_MS = 250;

const SOURCE_STATUS_TONE: Record<
  Schemas.KnowledgeSourceStatusIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Active]: Schemas.DashboardChipToneEnum.Success,
  [Syncing]: Schemas.DashboardChipToneEnum.Brand,
  [Failed]: Schemas.DashboardChipToneEnum.Destructive,
  [Paused]: Schemas.DashboardChipToneEnum.Neutral,
};

const DOCUMENT_STATUS_TONE: Record<
  Schemas.KnowledgeDocumentIndexStatusIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending]: Schemas.DashboardChipToneEnum.Neutral,
  [Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.KnowledgeDocumentIndexStatusIntEnum.Failed]: Schemas.DashboardChipToneEnum.Destructive,
};

// DEV_NOTE: Document index states in the dashboard's words (DESIGN.md §8: no internal names)
const DOCUMENT_STATUS_TEXT: Record<Schemas.KnowledgeDocumentIndexStatusIntEnum, string> = {
  [Schemas.KnowledgeDocumentIndexStatusIntEnum.Pending]: "Waiting",
  [Schemas.KnowledgeDocumentIndexStatusIntEnum.Indexed]: "Ready",
  [Schemas.KnowledgeDocumentIndexStatusIntEnum.Failed]: "Couldn't read",
};

const TYPE_OPTIONS = [
  { value: Sitemap, label: "Sitemap", hint: "Every page listed in a sitemap.xml" },
  { value: Url, label: "URL", hint: "One web page" },
  { value: Upload, label: "Upload", hint: "Files you upload (PDF, Word, HTML, Markdown, text)" },
];

const FREQUENCY_OPTIONS = [
  Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
  Schemas.KnowledgeSourceSyncFrequencyIntEnum.Weekly,
  Schemas.KnowledgeSourceSyncFrequencyIntEnum.Manual,
].map((value) => ({
  value: String(value),
  label: Schemas.KNOWLEDGE_SOURCE_SYNC_FREQUENCY_LABEL_MAP[value],
}));

const CLUSTER_TABS: { value: Schemas.DocGapClusterListTabEnum; label: string }[] = [
  { value: Schemas.DocGapClusterListTabEnum.Open, label: "Open" },
  { value: Schemas.DocGapClusterListTabEnum.Answered, label: "Answered" },
  { value: Schemas.DocGapClusterListTabEnum.Dismissed, label: "Dismissed" },
];

const CLUSTER_EMPTY_TEXT: Record<Schemas.DocGapClusterListTabEnum, string> = {
  [Schemas.DocGapClusterListTabEnum.Open]:
    "No unanswered questions. When the assistant can't answer something, similar questions are grouped here.",
  [Schemas.DocGapClusterListTabEnum.Answered]: "No group has been answered with a document yet.",
  [Schemas.DocGapClusterListTabEnum.Dismissed]: "No group was dismissed yet.",
};

const isWebSource = (source: Pick<Schemas.KnowledgeSourceWithStatus, "type">) =>
  source.type !== Upload;

// DEV_NOTE: A web address without its scheme ("help.example.com/sitemap.xml")
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

// DEV_NOTE: When a source last synced: "2 hours ago" within a day, else "29 Sep"; "Never" before its first good sync
function lastSyncText(lastSyncedAt: string | Date | null): string {
  if (lastSyncedAt === null) return "Never";
  const iso = new Date(lastSyncedAt).toISOString();
  return Date.now() - Date.parse(iso) < 86_400_000
    ? Utilities.formatTimeAgo(iso)
    : Utilities.formatWhen(iso);
}

// DEV_NOTE: The newest question's day: "latest Today", "latest 2 days ago"
function latestText(iso: string | null): string | null {
  if (iso === null) return null;
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "latest Today";
  return `latest ${Utilities.plural(days, "day")} ago`;
}

function uploadedText(addedCount: number): string {
  return `${Utilities.plural(addedCount, "file")} added. They're ready to use once the sync finishes.`;
}

// DEV_NOTE: Sends files one after another into an upload source; a failed one is toasted by the mutation and the rest
// still go. Resolves with how many were added.
async function uploadEach(upload: (file: File) => Promise<unknown>, files: File[]) {
  let addedCount = 0;
  for (const file of files) {
    try {
      await upload(file);
      addedCount++;
    } catch {
      // DEV_NOTE: Already toasted (onError); the next file still goes
    }
  }
  return addedCount;
}

function Pager({ page, pageSize, totalRecords, onPage }: Schemas.DashboardPagerProps) {
  const pageCount = Math.max(1, Math.ceil(totalRecords / pageSize));
  if (pageCount <= 1) return null;
  return (
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
  );
}

function SourceStatus({ source }: Schemas.DashboardKnowledgeSourceProps) {
  return (
    <StatusChip
      label={source.knowledgeSourceStatusLabel}
      tone={SOURCE_STATUS_TONE[source.knowledgeSourceStatus]}
    />
  );
}

// DEV_NOTE: The whole /knowledge body. Add source lives here so the groups' "Add an upload source" can open it.
export function KnowledgePage({ search }: Schemas.DashboardKnowledgePageProps) {
  const navigate = useNavigate();
  const [addSourceType, setAddSourceType] = useState<Schemas.KnowledgeSourceTypeIntEnum | null>(
    null,
  );
  const goTo = (next: Schemas.KnowledgePageSearch) =>
    void navigate({ to: "/knowledge", search: Schemas.ZKnowledgePageSearch.parse(next) });

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Knowledge"
        description="What the assistant can read, and the gaps it ran into"
      />
      <KnowledgeSources
        page={search.sourcesPage ?? 1}
        onPage={(page) => goTo({ ...search, sourcesPage: page === 1 ? undefined : page })}
        onAddSource={(type) => setAddSourceType(type ?? Sitemap)}
      />
      <DocGapClusters
        tab={search.tab ?? Schemas.DocGapClusterListTabEnum.Open}
        page={search.page ?? 1}
        onSearch={(next) => goTo({ ...search, ...next })}
        onAddUploadSource={() => setAddSourceType(Upload)}
      />
      <AddSourceDialog initialType={addSourceType} onClose={() => setAddSourceType(null)} />
    </div>
  );
}

// DEV_NOTE: Sources (DESIGN.md dashboard-Knowledge): the table, then one banner per failed source on this page
function KnowledgeSources({ page, onPage, onAddSource }: Schemas.DashboardKnowledgeSourcesProps) {
  const query = useKnowledgeSources(page);
  const counted = useKnowledgeSourcesCount();
  const sources = query.data?.knowledgeSources;
  // DEV_NOTE: Every Failed source has its banner, whatever page of the table is shown
  const failedSources = useFailedKnowledgeSources().data?.knowledgeSources ?? [];

  return (
    <section className="flex flex-col gap-4" aria-label="Sources">
      <SectionHeader
        title="Sources"
        description="Shared by every bot. Each bot chooses which sources it searches."
      >
        <Button onClick={() => onAddSource()}>
          <Plus aria-hidden />
          Add source
        </Button>
      </SectionHeader>

      {query.isPending && <Skeleton className="h-48 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !sources && (
        <PageError title="Sources didn't load" onRetry={() => void query.refetch()} />
      )}
      {sources && sources.length === 0 && page === 1 && (
        <div className="flex flex-col items-start gap-3 rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            No sources yet. Add your help center's sitemap, a page, or upload files so the assistant
            can answer from them.
          </p>
        </div>
      )}
      {sources && (sources.length > 0 || page > 1) && (
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
                  <TableHead className="px-4">Source</TableHead>
                  <TableHead className="px-4">Type</TableHead>
                  <TableHead className="px-4">From</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4 text-right">Documents</TableHead>
                  <TableHead className="px-4">Re-sync</TableHead>
                  <TableHead className="px-4">Last sync</TableHead>
                  <TableHead className="w-12 px-2">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((source) => (
                  <TableRow key={source.publicId}>
                    <TableCell className="px-4 py-3">
                      <Link
                        to="/knowledge/$id"
                        params={{ id: source.publicId }}
                        className="font-medium text-foreground hover:text-brand-text"
                      >
                        {source.name}
                      </Link>
                    </TableCell>
                    <TableCell className="px-4 py-3 text-subtle-foreground">
                      {source.typeLabel}
                    </TableCell>
                    <TableCell className="max-w-64 truncate px-4 py-3 text-subtle-foreground">
                      {source.url
                        ? shortUrl(source.url)
                        : Utilities.plural(source.documentCount, "file")}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <SourceStatus source={source} />
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right tabular-nums">
                      {Utilities.formatCount(source.documentCount)}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-subtle-foreground">
                      {source.syncFrequencyLabel ?? "—"}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-subtle-foreground">
                      {lastSyncText(source.lastSyncedAt)}
                    </TableCell>
                    <TableCell className="px-2 py-1.5">
                      <SourceActions source={source} isOnSourcePage={false} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {sources.length === 0 && (
            <p className="text-body text-muted-foreground">Nothing on this page.</p>
          )}
          <Pager
            page={page}
            pageSize={Schemas.KNOWLEDGE_SOURCES_PAGE_SIZE}
            totalRecords={counted.data?.totalRecords ?? 0}
            onPage={onPage}
          />
        </div>
      )}

      {failedSources.map((source) => (
        <FailedSourceAlert key={source.publicId} source={source} />
      ))}
    </section>
  );
}

// DEV_NOTE: A failed sync (DESIGN.md §5 banner): what the assistant still uses, and Retry sync. The reason isn't
// stored, so the banner doesn't guess one.
function FailedSourceAlert({ source }: Schemas.DashboardKnowledgeSourceProps) {
  const sync = useSyncKnowledgeSource(source.publicId);
  return (
    <Alert className="items-center border-0 bg-destructive-soft py-4 text-foreground has-data-[slot=alert-action]:pr-36">
      <Warning className="text-destructive" aria-hidden />
      <AlertDescription className="text-body text-foreground">
        {source.lastSyncedAt
          ? `${source.name} sync failed. Answers use the last good copy from ${Utilities.formatWhen(
              new Date(source.lastSyncedAt).toISOString(),
            )}.`
          : `${source.name} sync failed. The assistant can't use it until a sync works.`}
      </AlertDescription>
      <AlertAction className="top-1/2 -translate-y-1/2">
        <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <ArrowsClockwise aria-hidden />
          Retry sync
        </Button>
      </AlertAction>
    </Alert>
  );
}

// DEV_NOTE: A source's actions (row menu or source page): Sync now, Edit, Pause / Resume, Upload files (upload sources),
// Delete with a confirm. Sync now is off while the source is paused or syncing.
function SourceActions({ source, isOnSourcePage }: Schemas.DashboardKnowledgeSourceActionsProps) {
  const navigate = useNavigate();
  const sync = useSyncKnowledgeSource(source.publicId);
  const update = useUpdateKnowledgeSource(source.publicId);
  const remove = useDeleteKnowledgeSource(source.publicId);
  const upload = useUploadKnowledgeDocument();
  const fileInput = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const status = source.knowledgeSourceStatus;
  const isPaused = status === Paused;
  const isBusy = sync.isPending || update.isPending || remove.isPending || upload.isPending;

  const onFiles = (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (fileInput.current) fileInput.current.value = "";
    if (files.length === 0) return;
    const send = (file: File) => upload.mutateAsync({ sourcePublicId: source.publicId, file });
    void uploadEach(send, files).then((addedCount) => {
      if (addedCount > 0) toast.success(uploadedText(addedCount));
    });
  };

  const deleteSource = () => {
    remove
      .mutateAsync()
      .then(() => {
        setIsConfirmingDelete(false);
        if (isOnSourcePage) void navigate({ to: "/knowledge" });
      })
      .catch(() => undefined);
  };

  const items = (
    <>
      <DropdownMenuItem
        disabled={isBusy || isPaused || status === Syncing}
        onSelect={() => sync.mutate()}
      >
        <ArrowsClockwise aria-hidden />
        Sync now
      </DropdownMenuItem>
      {source.type === Upload && (
        <DropdownMenuItem disabled={isBusy} onSelect={() => fileInput.current?.click()}>
          <Plus aria-hidden />
          Upload files
        </DropdownMenuItem>
      )}
      <DropdownMenuItem disabled={isBusy} onSelect={() => setIsEditing(true)}>
        Edit
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={isBusy}
        onSelect={() => update.mutate({ knowledgeSource: { status: isPaused ? Active : Paused } })}
      >
        {isPaused ? "Resume" : "Pause"}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={isBusy}
        onSelect={() => setIsConfirmingDelete(true)}
      >
        <Trash aria-hidden />
        Delete
      </DropdownMenuItem>
    </>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {isOnSourcePage ? (
            <Button variant="outline">
              Actions
              <CaretDown aria-hidden />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-subtle-foreground"
              aria-label={`Actions for ${source.name}`}
            >
              <DotsThree />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">{items}</DropdownMenuContent>
      </DropdownMenu>
      {source.type === Upload && (
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="hidden"
          aria-label={`Upload files to ${source.name}`}
          onChange={(event) => onFiles(event.target.files)}
        />
      )}
      <EditSourceDialog source={source} isOpen={isEditing} onClose={() => setIsEditing(false)} />
      <AlertDialog open={isConfirmingDelete} onOpenChange={setIsConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {source.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its documents are removed with it and the assistant stops answering from them.
              {isWebSource(source) && " Adding the site again syncs every page from the start."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={(event) => {
                event.preventDefault();
                deleteSource();
              }}
            >
              {remove.isPending ? "Deleting…" : "Delete source"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function nameIssue(value: string): string | undefined {
  return Schemas.ZKnowledgeSourceName.safeParse(value).success
    ? undefined
    : `Give the source a name, up to ${Schemas.KNOWLEDGE_SOURCE_NAME_MAX_CHARS} characters.`;
}

function urlIssue(value: string): string | undefined {
  return Schemas.ZKnowledgeSourceUrl.safeParse(value.trim()).success
    ? undefined
    : "Enter a public web address starting with https://";
}

function NameField({
  id,
  name,
  value,
  errors,
  onBlur,
  onChange,
}: Schemas.DashboardKnowledgeNameFieldProps) {
  return (
    <Field data-invalid={errors.length > 0}>
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        id={id}
        name={name}
        placeholder="Help center"
        value={value}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={errors.length > 0}
      />
      <FieldError errors={errors.map((message) => ({ message }))} />
    </Field>
  );
}

function FrequencySelect({ id, value, onChange }: Schemas.DashboardKnowledgeFrequencySelectProps) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Re-sync</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FREQUENCY_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>Manual syncs only when you choose Sync now.</FieldDescription>
    </Field>
  );
}

// DEV_NOTE: Add source: a name, the type and, for a website, its address and re-sync (its first sync starts at once);
// an upload source takes files right away, sent after it is created
function AddSourceDialog({ initialType, onClose }: Schemas.DashboardKnowledgeAddSourceDialogProps) {
  return (
    <Dialog open={initialType !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {initialType !== null && (
          <AddSourceForm key={initialType} initialType={initialType} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddSourceForm({
  initialType,
  onClose,
}: Schemas.DashboardKnowledgeAddSourceDialogProps & {
  initialType: Schemas.KnowledgeSourceTypeIntEnum;
}) {
  const create = useCreateKnowledgeSource();
  const upload = useUploadKnowledgeDocument();
  const [files, setFiles] = useState<File[]>([]);
  const form = useForm({
    defaultValues: {
      name: "",
      type: initialType,
      url: "",
      syncFrequency: String(Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily),
    },
    onSubmit: async ({ value }) => {
      const syncFrequency = Number(
        value.syncFrequency,
      ) as Schemas.KnowledgeSourceSyncFrequencyIntEnum;
      const knowledgeSource: Schemas.KnowledgeSourceBase =
        value.type === Upload
          ? { type: Upload, name: value.name.trim() }
          : { type: value.type, name: value.name.trim(), url: value.url.trim(), syncFrequency };
      const created = await create.mutateAsync({ knowledgeSource });
      const sourcePublicId = created.knowledgeSource?.publicId;
      if (value.type !== Upload) {
        toast.success("Source added. Its first sync has started.");
      } else if (sourcePublicId && files.length > 0) {
        const send = (file: File) => upload.mutateAsync({ sourcePublicId, file });
        const addedCount = await uploadEach(send, files);
        if (addedCount > 0) toast.success(uploadedText(addedCount));
      } else {
        toast.success("Source added. Upload files to it from its menu.");
      }
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
        <DialogTitle>Add source</DialogTitle>
        <DialogDescription>
          The assistant answers from what it reads here. Each bot chooses which sources it searches.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="name" validators={{ onChange: ({ value }) => nameIssue(value) }}>
        {(field) => (
          <NameField
            id="source-name"
            name={field.name}
            value={field.state.value}
            errors={field.state.meta.errors.map(String)}
            onBlur={field.handleBlur}
            onChange={field.handleChange}
          />
        )}
      </form.Field>
      <form.Field name="type">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="source-type">Type</FieldLabel>
            <Select
              value={String(field.state.value)}
              onValueChange={(value) =>
                field.handleChange(Number(value) as Schemas.KnowledgeSourceTypeIntEnum)
              }
            >
              <SelectTrigger id="source-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {TYPE_OPTIONS.find((option) => option.value === field.state.value)?.hint}
            </FieldDescription>
          </Field>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.type}>
        {(type) =>
          type === Upload ? (
            <Field>
              <FieldLabel htmlFor="source-files">Files</FieldLabel>
              <Input
                id="source-files"
                type="file"
                multiple
                accept={UPLOAD_ACCEPT}
                onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
              />
              <FieldDescription>
                Optional. Up to{" "}
                {Utilities.formatCount(Schemas.KNOWLEDGE_UPLOAD_MAX_BYTES / 1024 / 1024)} MB each;
                you can add more later.
              </FieldDescription>
            </Field>
          ) : (
            <>
              <form.Field name="url" validators={{ onChange: ({ value }) => urlIssue(value) }}>
                {(field) => (
                  <Field data-invalid={field.state.meta.errors.length > 0}>
                    <FieldLabel htmlFor="source-url">
                      {type === Sitemap ? "Sitemap address" : "Page address"}
                    </FieldLabel>
                    <Input
                      id="source-url"
                      name={field.name}
                      inputMode="url"
                      placeholder={
                        type === Sitemap
                          ? "https://help.example.com/sitemap.xml"
                          : "https://example.com/policies/fire"
                      }
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-invalid={field.state.meta.errors.length > 0}
                    />
                    <FieldError
                      errors={field.state.meta.errors.map((message) => ({
                        message: String(message),
                      }))}
                    />
                  </Field>
                )}
              </form.Field>
              <form.Field name="syncFrequency">
                {(field) => (
                  <FrequencySelect
                    id="source-frequency"
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </form.Field>
            </>
          )
        }
      </form.Subscribe>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Adding…" : "Add source"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

// DEV_NOTE: Edit: the name of any source, the re-sync of a website. Only what changed is sent.
function EditSourceDialog({
  source,
  isOpen,
  onClose,
}: Schemas.DashboardKnowledgeEditSourceDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {isOpen && <EditSourceForm source={source} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function EditSourceForm({
  source,
  onClose,
}: Pick<Schemas.DashboardKnowledgeEditSourceDialogProps, "source" | "onClose">) {
  const update = useUpdateKnowledgeSource(source.publicId);
  const isWeb = isWebSource(source);
  const form = useForm({
    defaultValues: {
      name: source.name,
      syncFrequency: String(
        source.syncFrequency ?? Schemas.KnowledgeSourceSyncFrequencyIntEnum.Daily,
      ),
    },
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      const syncFrequency = Number(
        value.syncFrequency,
      ) as Schemas.KnowledgeSourceSyncFrequencyIntEnum;
      const changes: Schemas.UpdateKnowledgeSourceApiRequest["knowledgeSource"] = {
        ...(name !== source.name && { name }),
        ...(isWeb && syncFrequency !== source.syncFrequency && { syncFrequency }),
      };
      if (Object.keys(changes).length > 0) {
        await update.mutateAsync({ knowledgeSource: changes });
        toast.success("Source updated.");
      }
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
        <DialogTitle>Edit source</DialogTitle>
        <DialogDescription>
          {source.url ? shortUrl(source.url) : `${source.typeLabel} source`}. The address can't
          change: add a new source for a new address.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="name" validators={{ onChange: ({ value }) => nameIssue(value) }}>
        {(field) => (
          <NameField
            id="edit-source-name"
            name={field.name}
            value={field.state.value}
            errors={field.state.meta.errors.map(String)}
            onBlur={field.handleBlur}
            onChange={field.handleChange}
          />
        )}
      </form.Field>
      {isWeb && (
        <form.Field name="syncFrequency">
          {(field) => (
            <FrequencySelect
              id="edit-source-frequency"
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
      )}
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

// DEV_NOTE: Questions it couldn't answer (DESIGN.md dashboard-Knowledge): tabs with counts, the groups, pages
function DocGapClusters({
  tab,
  page,
  onSearch,
  onAddUploadSource,
}: Schemas.DashboardDocGapClustersProps) {
  const query = useDocGapClusters(tab, page);
  const dismiss = useDismissDocGapCluster();
  const [answering, setAnswering] = useState<Schemas.DocGapClusterListItem | null>(null);
  const data = query.data;
  const clusters = data?.docGapClusters;
  const isStale = query.isPlaceholderData;

  return (
    <section className="flex flex-col gap-4" aria-label="Questions it couldn't answer">
      <SectionHeader
        title="Questions it couldn't answer"
        description="Grouped from conversations. Personal details removed."
      />
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={tab}
        onValueChange={(value) => {
          const next = Schemas.ZDocGapClusterListTab.safeParse(value);
          if (next.success) {
            onSearch({
              tab: next.data === Schemas.DocGapClusterListTabEnum.Open ? undefined : next.data,
              page: undefined,
            });
          }
        }}
        aria-label="Show"
        className="flex-wrap self-start"
      >
        {CLUSTER_TABS.map((item) => (
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

      {query.isPending && <Skeleton className="h-40 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !clusters && (
        <PageError title="Questions didn't load" onRetry={() => void query.refetch()} />
      )}
      {clusters && clusters.length === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            {page > 1 ? "Nothing on this page." : CLUSTER_EMPTY_TEXT[tab]}
          </p>
          {page > 1 && (
            <Button variant="outline" onClick={() => onSearch({ tab, page: undefined })}>
              First page
            </Button>
          )}
        </div>
      )}
      {clusters && clusters.length > 0 && (
        <div
          aria-busy={isStale}
          className={cn(
            "flex flex-col gap-3 transition-opacity",
            isStale && "pointer-events-none opacity-50",
          )}
        >
          <ul className="divide-y overflow-hidden rounded-xl border" aria-label="Question groups">
            {clusters.map((cluster) => (
              <ClusterRow
                key={cluster.publicId}
                cluster={cluster}
                isDismissing={dismiss.isPending && dismiss.variables === cluster.publicId}
                onAddDocument={setAnswering}
                onDismiss={(row) => dismiss.mutate(row.publicId)}
              />
            ))}
          </ul>
          <Pager
            page={page}
            pageSize={Schemas.DOC_GAP_CLUSTERS_PAGE_SIZE}
            totalRecords={data?.totalRecords ?? 0}
            onPage={(next) => onSearch({ tab, page: next === 1 ? undefined : next })}
          />
        </div>
      )}
      <AnswerDialog
        cluster={answering}
        onClose={() => setAnswering(null)}
        onAddUploadSource={() => {
          setAnswering(null);
          onAddUploadSource();
        }}
      />
    </section>
  );
}

// DEV_NOTE: One group: its topic, how many asked and when last, its newest questions (opened on demand), and while
// Open "Add a document" and Dismiss; an Answered one links to the document that closed it
function ClusterRow({
  cluster,
  isDismissing,
  onAddDocument,
  onDismiss,
}: Schemas.DashboardDocGapClusterRowProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const isOpen = cluster.docGapClusterStatus === Schemas.DocGapClusterStatusIntEnum.Open;
  const latest = latestText(cluster.latestQuestionAt);
  const hasSamples = cluster.sampleQuestions.length > 0;
  const samplesId = `cluster-samples-${cluster.publicId}`;

  return (
    <li className="flex flex-col gap-3 px-[22px] py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {hasSamples ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="-ml-2 text-subtle-foreground"
              aria-expanded={isExpanded}
              aria-controls={samplesId}
              aria-label={isExpanded ? "Hide questions" : "Show questions"}
              onClick={() => setIsExpanded((value) => !value)}
            >
              {isExpanded ? <CaretDown /> : <CaretRight />}
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="text-body font-medium break-words text-foreground">{cluster.label}</p>
            <p className="text-caption text-muted-foreground">
              {Utilities.plural(cluster.questionCount, "question")}
              {latest && `, ${latest}`}
            </p>
          </div>
        </div>
        {isOpen && (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              className="text-subtle-foreground"
              disabled={isDismissing}
              onClick={() => onDismiss(cluster)}
            >
              Dismiss
            </Button>
            <Button variant="outline" onClick={() => onAddDocument(cluster)}>
              <Plus aria-hidden />
              Add a document
            </Button>
          </div>
        )}
        {cluster.docGapClusterStatus === Schemas.DocGapClusterStatusIntEnum.Dismissed && (
          <StatusChip label="Dismissed" tone={Schemas.DashboardChipToneEnum.Neutral} />
        )}
      </div>
      {cluster.answeredBy && (
        <p className="flex flex-wrap items-center gap-1.5 text-body text-subtle-foreground">
          <FileText className="size-4 shrink-0" aria-hidden />
          Answered by
          <Link
            to="/knowledge/$id"
            params={{ id: cluster.answeredBy.knowledgeSource.publicId }}
            // DEV_NOTE: Opens the source's documents filtered to this one's title, with its row highlighted
            search={{
              search: cluster.answeredBy.title ?? undefined,
              documentId: cluster.answeredBy.documentPublicId,
            }}
            className="font-medium text-brand-text hover:text-foreground"
          >
            {cluster.answeredBy.title ?? UNTITLED_DOCUMENT}
          </Link>
          <span className="text-muted-foreground">
            in {cluster.answeredBy.knowledgeSource.name}
          </span>
          {cluster.answeredBy.sourceUrl && (
            <a
              href={cluster.answeredBy.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-subtle-foreground hover:text-foreground"
              aria-label="Open the page"
            >
              <ArrowSquareOut className="size-4" />
            </a>
          )}
        </p>
      )}
      {isExpanded && hasSamples && (
        <ul
          id={samplesId}
          className="flex flex-col gap-1.5 rounded-lg bg-surface-subtle px-3.5 py-3"
        >
          {[...new Set(cluster.sampleQuestions)].map((question) => (
            // DEV_NOTE: Two questions can read the same once rewritten; one line shows them
            <li key={question} className="text-body break-words text-subtle-foreground">
              "{question}"
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

// DEV_NOTE: Add a document: upload a file into an upload source, or pick a document of any source; the group is then
// answered by it. With no upload source yet, the upload side offers Add source instead.
function AnswerDialog({
  cluster,
  onClose,
  onAddUploadSource,
}: Schemas.DashboardDocGapAnswerDialogProps) {
  return (
    <Dialog open={cluster !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {cluster && (
          <AnswerForm
            key={cluster.publicId}
            cluster={cluster}
            onClose={onClose}
            onAddUploadSource={onAddUploadSource}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AnswerForm({
  cluster,
  onClose,
  onAddUploadSource,
}: Schemas.DashboardDocGapAnswerDialogProps & { cluster: Schemas.DocGapClusterListItem }) {
  const choices = useKnowledgeSourceChoices(true);
  const upload = useUploadKnowledgeDocument();
  const answer = useAnswerDocGapCluster();
  const sources = choices.data?.knowledgeSources ?? [];
  const uploadSources = sources.filter((source) => source.type === Upload);
  const [mode, setMode] = useState(Schemas.DashboardDocGapAnswerModeEnum.Upload);
  const [uploadSourceId, setUploadSourceId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pickSourceId, setPickSourceId] = useState("");
  const [search, setSearch] = useState("");
  const [documentId, setDocumentId] = useState("");
  // DEV_NOTE: The file already uploaded for this answer: a retry after a failed answer reuses it instead of uploading
  // the same file again (uploads have no unique key, so each would be another document)
  const [uploaded, setUploaded] = useState<Schemas.DashboardUploadedAnswerDocument | null>(null);
  const chosenUploadSource = uploadSourceId || (uploadSources[0]?.publicId ?? "");
  const chosenPickSource = pickSourceId || (sources[0]?.publicId ?? "");
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const matches = useKnowledgeDocuments({
    publicId: chosenPickSource,
    page: 1,
    search: debouncedSearch,
    pageSize: PICKER_PAGE_SIZE + 1,
    isEnabled: mode === Schemas.DashboardDocGapAnswerModeEnum.Pick,
  });
  const isBusy = upload.isPending || answer.isPending;
  const canSubmit =
    mode === Schemas.DashboardDocGapAnswerModeEnum.Upload
      ? file !== null && chosenUploadSource !== ""
      : documentId !== "";

  const submit = async () => {
    let documentPublicId = documentId;
    if (mode === Schemas.DashboardDocGapAnswerModeEnum.Upload) {
      if (!file) return;
      if (uploaded?.file === file && uploaded.sourcePublicId === chosenUploadSource) {
        documentPublicId = uploaded.documentPublicId;
      } else {
        const response = await upload.mutateAsync({ sourcePublicId: chosenUploadSource, file });
        documentPublicId = response.knowledgeDocument?.publicId ?? "";
        if (!documentPublicId) return;
        setUploaded({ file, sourcePublicId: chosenUploadSource, documentPublicId });
      }
    }
    try {
      await answer.mutateAsync({ clusterPublicId: cluster.publicId, documentPublicId });
    } catch (error) {
      // DEV_NOTE: The group was closed meanwhile: a retry can't succeed (the mutation already said so)
      if (error instanceof ApiError && error.status === 409) onClose();
      throw error;
    }
    onClose();
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit().catch(() => undefined);
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a document</DialogTitle>
        <DialogDescription>
          For "{cluster.label}". The group is marked answered by the document you add.
        </DialogDescription>
      </DialogHeader>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={mode}
        onValueChange={(value) => {
          if (value === Schemas.DashboardDocGapAnswerModeEnum.Pick) setMode(value);
          if (value === Schemas.DashboardDocGapAnswerModeEnum.Upload) setMode(value);
        }}
        aria-label="How"
        className="self-start"
      >
        <ToggleGroupItem value={Schemas.DashboardDocGapAnswerModeEnum.Upload} className="px-3">
          Upload a file
        </ToggleGroupItem>
        <ToggleGroupItem value={Schemas.DashboardDocGapAnswerModeEnum.Pick} className="px-3">
          Pick a document
        </ToggleGroupItem>
      </ToggleGroup>

      {choices.isPending && <Skeleton className="h-24 rounded-lg" aria-label="Loading" />}
      {choices.isError && (
        <PageError title="Sources didn't load" onRetry={() => void choices.refetch()} />
      )}

      {choices.data &&
        mode === Schemas.DashboardDocGapAnswerModeEnum.Upload &&
        uploadSources.length === 0 && (
          <div className="flex flex-col items-start gap-3">
            <p className="text-body text-muted-foreground">
              Files go into an upload source, and there isn't one yet.
            </p>
            <Button type="button" variant="outline" onClick={onAddUploadSource}>
              <Plus aria-hidden />
              Add an upload source
            </Button>
          </div>
        )}
      {choices.data &&
        mode === Schemas.DashboardDocGapAnswerModeEnum.Upload &&
        uploadSources.length > 0 && (
          <>
            {uploadSources.length > 1 && (
              <Field>
                <FieldLabel htmlFor="answer-upload-source">Add to</FieldLabel>
                <Select value={chosenUploadSource} onValueChange={setUploadSourceId}>
                  <SelectTrigger id="answer-upload-source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {uploadSources.map((source) => (
                      <SelectItem key={source.publicId} value={source.publicId}>
                        {source.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="answer-file">File</FieldLabel>
              <Input
                id="answer-file"
                type="file"
                accept={UPLOAD_ACCEPT}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <FieldDescription>
                {uploadSources.length === 1 && `Added to ${uploadSources[0]?.name}. `}It's ready to
                use once the sync finishes.
              </FieldDescription>
            </Field>
          </>
        )}

      {choices.data &&
        mode === Schemas.DashboardDocGapAnswerModeEnum.Pick &&
        sources.length === 0 && (
          <p className="text-body text-muted-foreground">There are no sources yet.</p>
        )}
      {choices.data &&
        mode === Schemas.DashboardDocGapAnswerModeEnum.Pick &&
        sources.length > 0 && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="answer-pick-source">Source</FieldLabel>
                <Select
                  value={chosenPickSource}
                  onValueChange={(value) => {
                    setPickSourceId(value);
                    setDocumentId("");
                  }}
                >
                  <SelectTrigger id="answer-pick-source" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((source) => (
                      <SelectItem key={source.publicId} value={source.publicId}>
                        {source.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="answer-search">Title</FieldLabel>
                <Input
                  id="answer-search"
                  placeholder="Search titles"
                  maxLength={Schemas.KNOWLEDGE_DOCUMENT_SEARCH_MAX_CHARS}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setDocumentId("");
                  }}
                />
              </Field>
            </div>
            <DocumentChoices
              response={matches.data}
              isPending={matches.isPending}
              isError={matches.isError}
              selectedId={documentId}
              onSelect={setDocumentId}
            />
          </>
        )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || isBusy}>
          {isBusy ? "Saving…" : "Mark answered"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// DEV_NOTE: The picker's matches as a radio list (one document closes the group)
function DocumentChoices({
  response,
  isPending,
  isError,
  selectedId,
  onSelect,
}: Schemas.DashboardDocumentChoicesProps) {
  if (isPending) return <Skeleton className="h-24 rounded-lg" aria-label="Loading" />;
  if (isError || !response) {
    return <p className="text-body text-destructive">Documents didn't load. Try again.</p>;
  }
  const matches = response.knowledgeDocuments ?? [];
  const documents = matches.slice(0, PICKER_PAGE_SIZE);
  const hasMore = matches.length > PICKER_PAGE_SIZE;
  if (documents.length === 0) {
    return <p className="text-body text-muted-foreground">No document matches.</p>;
  }
  return (
    <div
      role="radiogroup"
      aria-label="Documents"
      className="flex flex-col divide-y rounded-lg border"
    >
      {documents.map((document) => {
        const isSelected = document.publicId === selectedId;
        return (
          <button
            key={document.publicId}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(document.publicId)}
            className={cn(
              "flex items-center gap-2 px-3 py-2.5 text-left text-body text-foreground hover:bg-accent",
              isSelected && "bg-surface-subtle font-medium",
            )}
          >
            <FileText className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
            <span className="truncate">{document.title ?? UNTITLED_DOCUMENT}</span>
          </button>
        );
      })}
      {hasMore && (
        <p className="px-3 py-2 text-caption text-muted-foreground">
          Showing the first {PICKER_PAGE_SIZE}. Type more of the title to narrow it down.
        </p>
      )}
    </div>
  );
}

// DEV_NOTE: /knowledge/$id: one source, its state and actions, and its documents
export function KnowledgeSourcePage({
  publicId,
  search,
}: Schemas.DashboardKnowledgeSourcePageProps) {
  const navigate = useNavigate();
  const query = useKnowledgeSource(publicId);
  const counted = useKnowledgeDocumentsCount(publicId, "");
  const source = query.data?.knowledgeSource;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-14 w-72 rounded-md" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (!source) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Knowledge" description="What the assistant can read">
          <Button variant="outline" asChild>
            <Link to="/knowledge">All sources</Link>
          </Button>
        </PageHeader>
        {isNotFound ? (
          <p className="text-body text-muted-foreground">
            This source isn't available. It may have been deleted.
          </p>
        ) : (
          <PageError title="The source didn't load" onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={source.name}
        description={`${source.typeLabel} · ${
          source.url ? shortUrl(source.url) : "Files you upload"
        }`}
      >
        <Button variant="outline" asChild>
          <Link to="/knowledge">All sources</Link>
        </Button>
        <SourceActions source={source} isOnSourcePage />
      </PageHeader>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border px-[22px] py-5 text-body sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-muted-foreground">Status</dt>
          <dd>
            <SourceStatus source={source} />
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-muted-foreground">Documents</dt>
          <dd className="text-foreground tabular-nums">
            {counted.data?.totalRecords === undefined
              ? "—"
              : Utilities.formatCount(counted.data.totalRecords)}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-muted-foreground">Re-sync</dt>
          <dd className="text-foreground">{source.syncFrequencyLabel ?? "When you upload"}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-caption text-muted-foreground">Last sync</dt>
          <dd className="text-foreground">{lastSyncText(source.lastSyncedAt)}</dd>
        </div>
      </dl>

      {source.knowledgeSourceStatus === Failed && <FailedSourceAlert source={source} />}

      <KnowledgeDocuments
        source={source}
        search={search}
        onSearch={(next) =>
          void navigate({
            to: "/knowledge/$id",
            params: { id: publicId },
            search: Schemas.ZKnowledgeSourcePageSearch.parse(next),
          })
        }
      />
    </div>
  );
}

// DEV_NOTE: The documents table with a title filter. The filter and page live in the URL; the box's text reaches it
// once typing pauses. documentId (a gap cluster's "Answered by" link) is highlighted.
function KnowledgeDocuments({
  source,
  search,
  onSearch,
}: Schemas.DashboardKnowledgeDocumentsProps) {
  const page = search.page ?? 1;
  const filter = search.search ?? "";
  const [text, setText] = useState(filter);
  const debouncedText = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debouncedText !== filter) {
      onSearch({ ...search, search: debouncedText || undefined, page: undefined });
    }
  }, [debouncedText, filter, onSearch, search]);
  const query = useKnowledgeDocuments({
    publicId: source.publicId,
    page,
    search: filter,
    pageSize: Schemas.KNOWLEDGE_DOCUMENTS_PAGE_SIZE,
  });
  const counted = useKnowledgeDocumentsCount(source.publicId, filter);
  const documents = query.data?.knowledgeDocuments;
  const isUpload = source.type === Upload;
  const onPage = (next: number) => onSearch({ ...search, page: next === 1 ? undefined : next });

  return (
    <section className="flex flex-col gap-4" aria-label="Documents">
      <SectionHeader
        title="Documents"
        description={
          isUpload
            ? "The files in this source. Remove one and the assistant stops answering from it."
            : "The pages found at the last sync. A page that leaves the site leaves here too."
        }
      >
        <Input
          type="search"
          className="w-56"
          placeholder="Search titles"
          aria-label="Search titles"
          maxLength={Schemas.KNOWLEDGE_DOCUMENT_SEARCH_MAX_CHARS}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </SectionHeader>
      {query.isPending && <Skeleton className="h-48 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !documents && (
        <PageError title="Documents didn't load" onRetry={() => void query.refetch()} />
      )}
      {documents && documents.length === 0 && (
        <div className="rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            {page > 1
              ? "Nothing on this page."
              : filter
                ? "No document matches."
                : isUpload
                  ? "No files yet. Upload some from Actions."
                  : "No pages yet. They show up after the first sync."}
          </p>
        </div>
      )}
      {documents && documents.length > 0 && (
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
                  <TableHead className="px-4">Title</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Last sync</TableHead>
                  {isUpload && (
                    <TableHead className="w-12 px-2">
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((document) => (
                  <DocumentRow
                    key={document.publicId}
                    source={source}
                    document={document}
                    isHighlighted={document.publicId === search.documentId}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager
            page={page}
            pageSize={Schemas.KNOWLEDGE_DOCUMENTS_PAGE_SIZE}
            totalRecords={counted.data?.totalRecords ?? 0}
            onPage={onPage}
          />
        </div>
      )}
    </section>
  );
}

function DocumentRow({
  source,
  document,
  isHighlighted,
}: Schemas.DashboardKnowledgeDocumentRowProps) {
  const remove = useDeleteKnowledgeDocument(source.publicId);
  const [isConfirming, setIsConfirming] = useState(false);
  const title = document.title ?? UNTITLED_DOCUMENT;

  return (
    <TableRow
      className={cn(isHighlighted && "bg-brand-soft hover:bg-brand-soft")}
      aria-current={isHighlighted ? "true" : undefined}
    >
      <TableCell className="max-w-96 px-4 py-3">
        {document.sourceUrl ? (
          <a
            href={document.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-full items-center gap-1.5 text-foreground hover:text-brand-text"
          >
            <span className="truncate">{title}</span>
            <ArrowSquareOut className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
          </a>
        ) : (
          <span className="block truncate text-foreground">{title}</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip
          label={DOCUMENT_STATUS_TEXT[document.knowledgeDocumentIndexStatus]}
          tone={DOCUMENT_STATUS_TONE[document.knowledgeDocumentIndexStatus]}
        />
      </TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">
        {lastSyncText(document.lastSyncedAt)}
      </TableCell>
      {source.type === Upload && (
        <TableCell className="px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-subtle-foreground"
            aria-label={`Remove ${title}`}
            disabled={remove.isPending}
            onClick={() => setIsConfirming(true)}
          >
            <Trash />
          </Button>
          <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {title}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The assistant stops answering from it. A group of questions it answered goes back
                  to Open.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    remove
                      .mutateAsync(document.publicId)
                      .then(() => setIsConfirming(false))
                      .catch(() => undefined);
                  }}
                >
                  {remove.isPending ? "Removing…" : "Remove"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TableCell>
      )}
    </TableRow>
  );
}

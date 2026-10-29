import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { DotsThree, Plus } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Badge } from "@app/ui/components/badge";
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
import { Field, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
import { Skeleton } from "@app/ui/components/skeleton";
import { Switch } from "@app/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@app/ui/components/table";
import { cn } from "@app/ui/lib/utils";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { Pager, PastEndNote } from "@/components/pager";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import {
  useBotRows,
  useBotVersions,
  useBotVersionsCount,
  useCopyVersion,
  useCreateBot,
  useMakeDefaultBot,
  useReadOnlyMode,
  useSetReadOnlyMode,
  useUpdateBot,
} from "./-data";

const { Draft, Testing, Ready, Published, Archived } = Schemas.ChatbotConfigStatusIntEnum;

const BOT_STATUS_TONE: Record<Schemas.ChatbotStatusIntEnum, Schemas.DashboardChipToneEnum> = {
  [Schemas.ChatbotStatusIntEnum.Active]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.ChatbotStatusIntEnum.Paused]: Schemas.DashboardChipToneEnum.Warning,
};

export const VERSION_STATUS_TONE: Record<
  Schemas.ChatbotConfigStatusIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Draft]: Schemas.DashboardChipToneEnum.Neutral,
  [Testing]: Schemas.DashboardChipToneEnum.Brand,
  [Ready]: Schemas.DashboardChipToneEnum.Brand,
  [Published]: Schemas.DashboardChipToneEnum.Success,
  [Archived]: Schemas.DashboardChipToneEnum.Neutral,
};

export const TEST_RESULT_TONE: Record<
  Schemas.ChatbotConfigTestResultEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Schemas.ChatbotConfigTestResultEnum.Passed]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.ChatbotConfigTestResultEnum.Failed]: Schemas.DashboardChipToneEnum.Destructive,
  [Schemas.ChatbotConfigTestResultEnum.Running]: Schemas.DashboardChipToneEnum.Brand,
  [Schemas.ChatbotConfigTestResultEnum.NotRun]: Schemas.DashboardChipToneEnum.Neutral,
};

// DEV_NOTE: The whole /settings/bots body (DESIGN.md dashboard-Bots): the bots, the versions of the one picked in the URL
// (else the default, else the first), and the company's emergency switch
export function BotsPage({ search }: Schemas.DashboardBotsPageProps) {
  const navigate = useNavigate();
  const query = useBotRows();
  const [isCreating, setIsCreating] = useState(false);
  const chatbots = query.data?.chatbots;
  const selected =
    chatbots?.find((chatbot) => chatbot.publicId === search.botId) ??
    chatbots?.find((chatbot) => chatbot.isDefault) ??
    chatbots?.[0] ??
    null;
  const goTo = (next: Schemas.BotsPageSearch) =>
    void navigate({ to: "/settings/bots", search: Schemas.ZBotsPageSearch.parse(next) });

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Bots"
        description="Each bot has its own configuration, tests and dashboards"
      />
      <section className="flex flex-col gap-4" aria-label="Bots">
        <SectionHeader
          title="Bots"
          description="Each bot has its own configuration, tests and dashboards. Knowledge and keys are shared."
        >
          <Button onClick={() => setIsCreating(true)}>
            <Plus aria-hidden />
            New bot
          </Button>
        </SectionHeader>
        {query.isPending && <Skeleton className="h-32 rounded-xl" aria-label="Loading" />}
        {!query.isPending && !chatbots && (
          <PageError title="Bots didn't load" onRetry={() => void query.refetch()} />
        )}
        {chatbots && chatbots.length === 0 && (
          <div className="rounded-xl border px-[22px] py-5">
            <p className="text-body text-muted-foreground">
              No bots yet. Create one, then write and publish its first version.
            </p>
          </div>
        )}
        {chatbots && chatbots.length > 0 && (
          <BotsTable
            chatbots={chatbots}
            selectedPublicId={selected?.publicId ?? null}
            onSelect={(publicId) => goTo({ botId: publicId })}
          />
        )}
      </section>
      {selected && (
        <BotVersions
          key={selected.publicId}
          chatbot={selected}
          page={search.page ?? 1}
          onPage={(page) => goTo({ ...search, page: page === 1 ? undefined : page })}
        />
      )}
      <ReadOnlySwitch />
      <BotNameDialog chatbot={null} isOpen={isCreating} onClose={() => setIsCreating(false)} />
    </div>
  );
}

// ─── Bots

function BotsTable({ chatbots, selectedPublicId, onSelect }: Schemas.DashboardBotsTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-4">Bot</TableHead>
            <TableHead className="px-4">Status</TableHead>
            <TableHead className="px-4">Live config</TableHead>
            <TableHead className="px-4 text-right">
              Conversations ({Schemas.CHATBOT_CONVERSATION_COUNT_DAYS} d)
            </TableHead>
            <TableHead className="w-12 px-4">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {chatbots.map((chatbot) => (
            <BotRow
              key={chatbot.publicId}
              chatbot={chatbot}
              isSelected={chatbot.publicId === selectedPublicId}
              onSelect={onSelect}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BotRow({ chatbot, isSelected, onSelect }: Schemas.DashboardBotRowProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const update = useUpdateBot(chatbot.publicId);
  const makeDefault = useMakeDefaultBot();
  const isPaused = chatbot.chatbotStatus === Schemas.ChatbotStatusIntEnum.Paused;

  return (
    <TableRow className={cn(isSelected && "bg-surface-subtle")}>
      <TableCell className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-body font-medium text-foreground hover:underline"
            onClick={() => onSelect(chatbot.publicId)}
            aria-current={isSelected ? "true" : undefined}
          >
            {chatbot.name}
          </button>
          {chatbot.isDefault && <Badge className="bg-muted text-muted-foreground">Default</Badge>}
        </div>
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip
          label={chatbot.chatbotStatusLabel}
          tone={BOT_STATUS_TONE[chatbot.chatbotStatus]}
        />
      </TableCell>
      <TableCell className="px-4 py-3">
        {chatbot.liveConfig ? (
          <span className="font-mono text-mono-value text-foreground">
            v{chatbot.liveConfig.configVersion}
          </span>
        ) : (
          <span className="text-subtle-foreground">Not published</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-right tabular-nums text-foreground">
        {Utilities.formatCount(chatbot.conversationCount)}
      </TableCell>
      <TableCell className="px-4 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-subtle-foreground"
              aria-label={`Actions for ${chatbot.name}`}
            >
              <DotsThree />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onSelect(chatbot.publicId)}>
              Show versions
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setIsRenaming(true)}>Rename</DropdownMenuItem>
            {!chatbot.isDefault && (
              <DropdownMenuItem
                disabled={makeDefault.isPending}
                onSelect={() => makeDefault.mutate(chatbot.publicId)}
              >
                Make default
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={update.isPending}
              onSelect={() =>
                update.mutate({
                  chatbot: {
                    status: isPaused
                      ? Schemas.ChatbotStatusIntEnum.Active
                      : Schemas.ChatbotStatusIntEnum.Paused,
                  },
                })
              }
            >
              {isPaused ? "Resume" : "Pause"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <BotNameDialog chatbot={chatbot} isOpen={isRenaming} onClose={() => setIsRenaming(false)} />
      </TableCell>
    </TableRow>
  );
}

function nameIssue(value: string): string | undefined {
  return Schemas.ZChatbotBase.shape.name.safeParse(value).success
    ? undefined
    : "Give the bot a name.";
}

// DEV_NOTE: New bot (chatbot null) or Rename. The form is mounted only while the dialog is open, so every opening starts
// from the bot's current name (or empty), never from the last submit. Awaits the write (mutateAsync) and closes on
// success; the toast says why otherwise.
function BotNameDialog({ chatbot, isOpen, onClose }: Schemas.DashboardBotNameDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {isOpen && <BotNameForm chatbot={chatbot} isOpen={isOpen} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function BotNameForm({ chatbot, onClose }: Schemas.DashboardBotNameDialogProps) {
  const create = useCreateBot();
  const update = useUpdateBot(chatbot?.publicId ?? "");
  const form = useForm({
    defaultValues: { name: chatbot?.name ?? "" },
    onSubmit: async ({ value }) => {
      if (chatbot) {
        await update.mutateAsync({ chatbot: { name: value.name } });
      } else {
        await create.mutateAsync({ chatbot: { name: value.name } });
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
        <DialogTitle>{chatbot ? "Rename bot" : "New bot"}</DialogTitle>
        <DialogDescription>
          {chatbot
            ? "The new name shows in the widget header and on every page."
            : "The bot starts with no versions. Write its first draft, then publish it."}
        </DialogDescription>
      </DialogHeader>
      <form.Field name="name" validators={{ onChange: ({ value }) => nameIssue(value) }}>
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor={`bot-name-${chatbot?.publicId ?? "new"}`}>Name</FieldLabel>
            <Input
              id={`bot-name-${chatbot?.publicId ?? "new"}`}
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
              {isSubmitting ? "Saving…" : chatbot ? "Save name" : "Create bot"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

// ─── Versions

// DEV_NOTE: Open draft opens the bot's open version; with none, it copies the live version into a new draft, and with
// no live version either it starts a blank one (…/versions/new)
function BotVersions({ chatbot, page, onPage }: Schemas.DashboardBotVersionsProps) {
  const navigate = useNavigate();
  const list = useBotVersions(chatbot.publicId, page);
  const count = useBotVersionsCount(chatbot.publicId);
  const copy = useCopyVersion(chatbot.publicId);
  const versions = list.data?.chatbotConfigs;
  const totalRecords = count.data?.totalRecords ?? null;
  const pageSize = Schemas.CHATBOT_CONFIG_VERSIONS_PAGE_SIZE;

  const openVersion = (publicId: string) =>
    void navigate({
      to: "/settings/bots/$id/versions/$versionId",
      params: { id: chatbot.publicId, versionId: publicId },
    });
  const openDraft = async () => {
    if (chatbot.draftConfig) {
      openVersion(chatbot.draftConfig.publicId);
      return;
    }
    if (!chatbot.liveConfig) {
      void navigate({ to: "/settings/bots/$id/versions/new", params: { id: chatbot.publicId } });
      return;
    }
    const copied = await copy.mutateAsync(chatbot.liveConfig.publicId);
    if (copied.chatbotConfig) openVersion(copied.chatbotConfig.publicId);
  };

  return (
    <section className="flex flex-col gap-4" aria-label={`Versions of ${chatbot.name}`}>
      <SectionHeader
        title={`Versions of ${chatbot.name}`}
        description="Publishing a version makes it live from the next message. Rolling back copies an old version into a new draft."
      >
        <Button
          variant="outline"
          disabled={copy.isPending}
          onClick={() => void openDraft().catch(() => undefined)}
        >
          {chatbot.draftConfig || chatbot.liveConfig ? "Open draft" : "Write first version"}
        </Button>
      </SectionHeader>
      {list.isPending && <Skeleton className="h-40 rounded-xl" aria-label="Loading" />}
      {!list.isPending && !versions && (
        <PageError title="Versions didn't load" onRetry={() => void list.refetch()} />
      )}
      {versions && versions.length === 0 && page === 1 && (
        <div className="rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            No versions yet. Write the first one; the bot answers once a version is published.
          </p>
        </div>
      )}
      {versions && versions.length === 0 && page > 1 && (
        <PastEndNote pageSize={pageSize} totalRecords={totalRecords} onPage={onPage} />
      )}
      {versions && versions.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Version</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Tests</TableHead>
                  <TableHead className="px-4">Edited by</TableHead>
                  <TableHead className="px-4">When</TableHead>
                  <TableHead className="w-12 px-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((version) => (
                  <BotVersionRow
                    key={version.publicId}
                    chatbotPublicId={chatbot.publicId}
                    version={version}
                    canCopy={chatbot.draftConfig === null}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager
            page={page}
            pageSize={pageSize}
            totalRecords={totalRecords}
            rowCount={versions.length}
            onPage={onPage}
          />
        </>
      )}
    </section>
  );
}

function BotVersionRow({ chatbotPublicId, version, canCopy }: Schemas.DashboardBotVersionRowProps) {
  const navigate = useNavigate();
  const copy = useCopyVersion(chatbotPublicId);
  const isOpen = (Schemas.CHATBOT_CONFIG_OPEN_STATUSES as readonly number[]).includes(
    version.chatbotConfigStatus,
  );
  const copyToDraft = async () => {
    const copied = await copy.mutateAsync(version.publicId);
    if (copied.chatbotConfig) {
      void navigate({
        to: "/settings/bots/$id/versions/$versionId",
        params: { id: chatbotPublicId, versionId: copied.chatbotConfig.publicId },
      });
    }
  };

  return (
    <TableRow>
      <TableCell className="px-4 py-3">
        <Link
          to="/settings/bots/$id/versions/$versionId"
          params={{ id: chatbotPublicId, versionId: version.publicId }}
          className="font-mono text-mono-value text-foreground hover:underline"
        >
          v{version.configVersion}
        </Link>
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip
          label={version.chatbotConfigStatusLabel}
          tone={VERSION_STATUS_TONE[version.chatbotConfigStatus]}
        />
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip
          label={Schemas.CHATBOT_CONFIG_TEST_RESULT_LABEL_MAP[version.testResult]}
          tone={TEST_RESULT_TONE[version.testResult]}
        />
      </TableCell>
      <TableCell className="px-4 py-3 text-foreground">
        {version.editedByName ?? <span className="text-subtle-foreground">—</span>}
      </TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">
        {Utilities.formatWhen(version.updatedAt)}
      </TableCell>
      <TableCell className="px-4 py-3">
        {!isOpen && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-subtle-foreground"
                aria-label={`Actions for v${version.configVersion}`}
              >
                <DotsThree />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={!canCopy || copy.isPending}
                onSelect={() => void copyToDraft().catch(() => undefined)}
              >
                {canCopy ? "Copy to new draft" : "Copy to new draft (discard the open draft first)"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

// ─── Emergency switch

function ReadOnlySwitch() {
  const query = useReadOnlyMode();
  const setReadOnly = useSetReadOnlyMode();
  const mode = query.data?.readOnlyMode;

  return (
    <section className="flex flex-col gap-4" aria-label="Emergency switch">
      <SectionHeader title="Emergency switch" />
      {query.isPending && <Skeleton className="h-20 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !mode && (
        <PageError title="Read-only mode didn't load" onRetry={() => void query.refetch()} />
      )}
      {mode && (
        <div className="flex items-center justify-between gap-6 rounded-xl border px-[22px] py-5">
          <div className="flex flex-col gap-1">
            <label htmlFor="read-only-mode" className="text-body font-medium text-foreground">
              Read-only mode
            </label>
            <p className="text-caption text-muted-foreground">
              The assistant can still answer, but every write is blocked for all bots. Use it if
              something goes wrong.
            </p>
          </div>
          <Switch
            id="read-only-mode"
            checked={mode.isReadOnly}
            disabled={setReadOnly.isPending}
            onCheckedChange={(isReadOnly) => setReadOnly.mutate({ isReadOnly })}
          />
        </div>
      )}
    </section>
  );
}

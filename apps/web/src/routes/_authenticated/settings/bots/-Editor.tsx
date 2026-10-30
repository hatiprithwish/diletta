import { useCallback, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Alert, AlertDescription, AlertTitle } from "@app/ui/components/alert";
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
import { Skeleton } from "@app/ui/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { StatusChip } from "@/components/status-chip";
import { ApiError } from "@/providers/apiClient";
import Utilities from "@/utils";
import { TEST_RESULT_TONE, VERSION_STATUS_TONE } from "./-Components";
import { ConfigForm } from "./-DraftForm";
import { toConfigFormValues } from "./-configForm";
import {
  configRefusalOf,
  useBotRows,
  useBotVersion,
  useConfigOptions,
  useCopyVersion,
  useCreateDraft,
  useDiscardDraft,
  useMoveToDraft,
  usePublishVersion,
  useSaveDraft,
  useSendToTesting,
} from "./-data";

const { Draft, Testing, Ready, Published } = Schemas.ChatbotConfigStatusIntEnum;
const { Publish, Discard, SendToTesting, BackToDraft } = Schemas.DashboardVersionConfirmEnum;

// DEV_NOTE: The editor's line under the title, per status (M5-4: a draft goes live only through its tests)
const VERSION_DESCRIPTION: Partial<Record<Schemas.ChatbotConfigStatusIntEnum, string>> = {
  [Draft]:
    "A draft. Save your edits, then send it to testing. It can be published once its tests pass.",
  [Testing]:
    "In testing. Its tests run on your staging environment: it's ready to publish when they pass, and a draft again when they don't.",
  [Ready]: "Passed its tests. Publish it to make it live.",
};
const LOCKED_DESCRIPTION =
  "Versions that left draft don't change. Copy one into a new draft to change or roll back to it.";

// DEV_NOTE: Each confirmation's title, words and button
const CONFIRM_COPY: Record<
  Schemas.DashboardVersionConfirmEnum,
  { title: (version: number) => string; description: string; action: string }
> = {
  [Publish]: {
    title: (version) => `Publish v${version}?`,
    description:
      "It becomes the live version: every conversation uses it from the next message. The current live version is kept, and you can roll back by copying it.",
    action: "Publish",
  },
  [Discard]: {
    title: (version) => `Discard v${version}?`,
    description:
      "The draft is set aside and can't be edited again. The live version doesn't change.",
    action: "Discard draft",
  },
  [SendToTesting]: {
    title: (version) => `Send v${version} to testing?`,
    description:
      "It can't be edited while its tests run on your staging environment. It's ready to publish when they pass, including every safety case.",
    action: "Send to testing",
  },
  [BackToDraft]: {
    title: (version) => `Move v${version} back to draft?`,
    description:
      "You can edit it again. Its test result no longer counts: send it to testing again before publishing.",
    action: "Back to draft",
  },
};

function BackToBots({ chatbotPublicId }: Schemas.DashboardBotBackLinkProps) {
  return (
    <Link
      to="/settings/bots"
      search={{ botId: chatbotPublicId }}
      className="flex items-center gap-1.5 self-start text-caption text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft aria-hidden />
      Bots
    </Link>
  );
}

// DEV_NOTE: /settings/bots/$id/versions/$versionId (a version) or …/new (a blank first draft). The chatbot comes from the
// Bots table's query (the name and whether it has an open draft), the pickers from the options query, the version from its
// own. A draft is edited, published or discarded; any other version is read-only, with Copy to new draft.
export function BotVersionPage({
  chatbotPublicId,
  versionPublicId,
}: Schemas.DashboardBotVersionPageProps) {
  const rows = useBotRows();
  const options = useConfigOptions();
  const chatbot = rows.data?.chatbots?.find((row) => row.publicId === chatbotPublicId);

  if (rows.isPending || options.isPending) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (!rows.data?.chatbots || !options.data?.options) {
    return (
      <PageError
        title="This bot didn't load"
        onRetry={() => {
          void rows.refetch();
          void options.refetch();
        }}
      />
    );
  }
  if (!chatbot) return <VersionMissing chatbotPublicId={chatbotPublicId} />;

  return versionPublicId === null ? (
    <NewDraft chatbot={chatbot} options={options.data.options} />
  ) : (
    <ExistingVersion
      chatbot={chatbot}
      options={options.data.options}
      versionPublicId={versionPublicId}
    />
  );
}

function VersionMissing({ chatbotPublicId }: Schemas.DashboardBotBackLinkProps) {
  return (
    <div className="flex flex-col gap-6">
      <BackToBots chatbotPublicId={chatbotPublicId} />
      <div className="rounded-xl border px-[22px] py-5">
        <p className="text-body text-muted-foreground">
          This bot or version isn't available. It may have been removed.
        </p>
      </div>
    </div>
  );
}

function NewDraft({ chatbot, options }: Schemas.DashboardBotNewDraftProps) {
  const navigate = useNavigate();
  const create = useCreateDraft(chatbot.publicId);
  const [defaultValues] = useState(() => toConfigFormValues(null, options));
  const onDirtyChange = useCallback(() => undefined, []);

  // DEV_NOTE: A draft exists already (opened from an old link): open it instead of starting a second one
  if (chatbot.draftConfig) {
    return (
      <div className="flex flex-col gap-6">
        <BackToBots chatbotPublicId={chatbot.publicId} />
        <div className="flex flex-wrap items-center gap-3 rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            {chatbot.name} already has a draft, v{chatbot.draftConfig.configVersion}.
          </p>
          <Button variant="outline" asChild>
            <Link
              to="/settings/bots/$id/versions/$versionId"
              params={{ id: chatbot.publicId, versionId: chatbot.draftConfig.publicId }}
            >
              Open draft
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <BackToBots chatbotPublicId={chatbot.publicId} />
      <PageHeader
        title={`First version of ${chatbot.name}`}
        description="Write the draft and save it. Publishing makes it live."
      />
      <ConfigForm
        defaultValues={defaultValues}
        attachments={undefined}
        options={options}
        isEditable
        isNew
        onDirtyChange={onDirtyChange}
        onSave={async (body) => {
          const created = await create.mutateAsync({ body });
          if (created.chatbotConfig) {
            void navigate({
              to: "/settings/bots/$id/versions/$versionId",
              params: { id: chatbot.publicId, versionId: created.chatbotConfig.publicId },
              replace: true,
            });
          }
        }}
      />
    </div>
  );
}

function ExistingVersion({
  chatbot,
  options,
  versionPublicId,
}: Schemas.DashboardBotExistingVersionProps) {
  const query = useBotVersion(chatbot.publicId, versionPublicId);
  const version = query.data?.chatbotConfig;

  if (query.isPending) {
    return <Skeleton className="h-96 rounded-xl" aria-label="Loading" />;
  }
  if (query.error instanceof ApiError && query.error.status === 404) {
    return <VersionMissing chatbotPublicId={chatbot.publicId} />;
  }
  if (!version) {
    return <PageError title="This version didn't load" onRetry={() => void query.refetch()} />;
  }
  return <VersionEditor chatbot={chatbot} options={options} version={version} />;
}

function VersionEditor({ chatbot, options, version }: Schemas.DashboardBotVersionEditorProps) {
  const save = useSaveDraft(chatbot.publicId, version.publicId);
  const [isDirty, setIsDirty] = useState(false);
  const [refusal, setRefusal] = useState<Schemas.ChatbotConfigWriteApiResponse | null>(null);
  // DEV_NOTE: The form's defaults are taken once per version: a save resets the form to what was saved itself
  const [defaultValues] = useState(() => toConfigFormValues(version.body, options));
  const isDraft = version.chatbotConfigStatus === Draft;
  const onDirtyChange = useCallback((next: boolean) => setIsDirty(next), []);

  return (
    <div className="flex flex-col gap-6">
      <BackToBots chatbotPublicId={chatbot.publicId} />
      <PageHeader
        title={`${chatbot.name} v${version.configVersion}`}
        description={VERSION_DESCRIPTION[version.chatbotConfigStatus] ?? LOCKED_DESCRIPTION}
      >
        <VersionActions
          chatbotPublicId={chatbot.publicId}
          version={version}
          isDirty={isDirty}
          onRefusal={setRefusal}
        />
      </PageHeader>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-muted-foreground">
        <StatusChip
          label={version.chatbotConfigStatusLabel}
          tone={VERSION_STATUS_TONE[version.chatbotConfigStatus]}
        />
        <span className="flex items-center gap-1.5">
          Tests
          <StatusChip
            label={Schemas.CHATBOT_CONFIG_TEST_RESULT_LABEL_MAP[version.testResult]}
            tone={TEST_RESULT_TONE[version.testResult]}
          />
        </span>
        <span>
          Edited {version.editedByName ? `by ${version.editedByName} ` : ""}
          {Utilities.formatWhenWithTime(version.updatedAt)}
        </span>
        {version.publishedAt && (
          <span>Published {Utilities.formatWhenWithTime(version.publishedAt)}</span>
        )}
      </div>
      {version.body === null ? (
        <Alert className="border-0 bg-destructive-soft">
          <AlertTitle className="text-foreground">This version can't be shown</AlertTitle>
          <AlertDescription className="text-subtle-foreground">
            Its stored config doesn't read with this version of the dashboard, so it can't be edited
            or copied.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {version.failedSafetyCaseCount > 0 && version.chatbotConfigStatus !== Published && (
            <SafetyBlock failedSafetyCaseCount={version.failedSafetyCaseCount} />
          )}
          {(isDraft || version.chatbotConfigStatus === Ready) && (
            <PublishIssues
              body={version.body}
              options={options}
              refusal={refusal}
              isReady={version.chatbotConfigStatus === Ready}
            />
          )}
          <ConfigForm
            defaultValues={defaultValues}
            attachments={version.body.attachments}
            options={options}
            isEditable={isDraft}
            isNew={false}
            onDirtyChange={onDirtyChange}
            onSave={async (body) => {
              setRefusal(null);
              await save.mutateAsync({ body });
            }}
          />
        </>
      )}
    </div>
  );
}

// DEV_NOTE: Draft: Discard and Send to testing (which waits for unsaved edits to be saved, since it tests what is
// stored). Testing: Back to draft. Ready: Back to draft and Publish. Each is confirmed. Any other version: Copy to new
// draft, or Open draft while the bot already has one.
function VersionActions({
  chatbotPublicId,
  version,
  isDirty,
  onRefusal,
}: Schemas.DashboardVersionActionsProps) {
  const navigate = useNavigate();
  const rows = useBotRows();
  const copy = useCopyVersion(chatbotPublicId);
  const sendToTesting = useSendToTesting(chatbotPublicId, version.publicId);
  const moveToDraft = useMoveToDraft(chatbotPublicId, version.publicId);
  const publish = usePublishVersion(chatbotPublicId, version.publicId);
  const discard = useDiscardDraft(chatbotPublicId, version.publicId);
  const [confirming, setConfirming] = useState<Schemas.DashboardVersionConfirmEnum | null>(null);
  const draft = rows.data?.chatbots?.find((row) => row.publicId === chatbotPublicId)?.draftConfig;
  const status = version.chatbotConfigStatus;

  if (status !== Draft && status !== Testing && status !== Ready) {
    if (draft && draft.publicId !== version.publicId) {
      return (
        <Button variant="outline" asChild>
          <Link
            to="/settings/bots/$id/versions/$versionId"
            params={{ id: chatbotPublicId, versionId: draft.publicId }}
          >
            Open draft v{draft.configVersion}
          </Link>
        </Button>
      );
    }
    return (
      <Button
        variant="outline"
        disabled={copy.isPending || version.body === null}
        onClick={() =>
          void copy
            .mutateAsync(version.publicId)
            .then((copied) => {
              if (copied.chatbotConfig) {
                void navigate({
                  to: "/settings/bots/$id/versions/$versionId",
                  params: { id: chatbotPublicId, versionId: copied.chatbotConfig.publicId },
                });
              }
            })
            .catch(() => undefined)
        }
      >
        Copy to new draft
      </Button>
    );
  }

  const confirm = () => {
    const showRefusal = { onError: (error: unknown) => onRefusal(configRefusalOf(error)) };
    onRefusal(null);
    if (confirming === Publish) publish.mutate(undefined, showRefusal);
    if (confirming === SendToTesting) sendToTesting.mutate(undefined, showRefusal);
    if (confirming === BackToDraft) moveToDraft.mutate(undefined);
    if (confirming === Discard) {
      discard.mutate(undefined, {
        onSuccess: () =>
          void navigate({ to: "/settings/bots", search: { botId: chatbotPublicId } }),
      });
    }
    setConfirming(null);
  };
  const copyFor = confirming === null ? null : CONFIRM_COPY[confirming];

  return (
    <>
      {status === Draft ? (
        <>
          <Button
            variant="ghost"
            className="text-subtle-foreground"
            disabled={discard.isPending}
            onClick={() => setConfirming(Discard)}
          >
            Discard draft
          </Button>
          <Button
            disabled={isDirty || sendToTesting.isPending || version.body === null}
            title={isDirty ? "Save the draft first" : undefined}
            onClick={() => setConfirming(SendToTesting)}
          >
            {sendToTesting.isPending ? "Sending…" : "Send to testing"}
          </Button>
        </>
      ) : (
        <Button
          variant={status === Ready ? "ghost" : "outline"}
          className={status === Ready ? "text-subtle-foreground" : undefined}
          disabled={moveToDraft.isPending}
          onClick={() => setConfirming(BackToDraft)}
        >
          Back to draft
        </Button>
      )}
      {status === Ready && (
        <Button
          disabled={publish.isPending || version.body === null}
          onClick={() => setConfirming(Publish)}
        >
          {publish.isPending ? "Publishing…" : "Publish"}
        </Button>
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copyFor?.title(version.configVersion)}</AlertDialogTitle>
            <AlertDialogDescription>{copyFor?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirm}>{copyFor?.action}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// DEV_NOTE: The safety hard gate (M5-4): the version's last test run failed a safety case, which blocks publishing even
// above the pass threshold
function SafetyBlock({ failedSafetyCaseCount }: Schemas.DashboardSafetyBlockProps) {
  return (
    <Alert className="border-0 bg-destructive-soft">
      <AlertTitle className="text-foreground">A failed safety case blocks publishing</AlertTitle>
      <AlertDescription className="text-subtle-foreground">
        <p>
          {failedSafetyCaseCount === 1
            ? "1 safety case failed"
            : `${failedSafetyCaseCount} safety cases failed`}{" "}
          in this version's last test run, even if the rest passed. Fix the draft, then send it to
          testing again.
        </p>
        <Link to="/tests" className="text-foreground underline">
          See the test run
        </Link>
      </AlertDescription>
    </Alert>
  );
}

// DEV_NOTE: What would stop the saved version going to testing or live, seen from here (model keys, turned-on tools,
// priced models), and the last send's or publish's refusal (it checks again under its locks, so it has the last word)
function PublishIssues({ body, options, refusal, isReady }: Schemas.DashboardPublishIssuesProps) {
  const lines: string[] = [];
  if (refusal) {
    lines.push(refusal.message ?? "Nothing changed.");
  } else if (body) {
    const needs = Schemas.getChatbotConfigPublishNeeds(body);
    const missing = needs.providers.filter(
      (provider) => !options.activeKeyProviders.includes(provider),
    );
    if (missing.length > 0) {
      const names = missing.map((provider) => Schemas.MODEL_PROVIDER_LABEL_MAP[provider]);
      lines.push(`Add a working model key for ${names.join(" and ")} before publishing.`);
    }
    if (needs.unpricedModels.length > 0) {
      lines.push(`Choose a supported model instead of ${needs.unpricedModels.join(", ")}.`);
    }
    const active = new Set(options.tools.map((tool) => `${tool.name}@${tool.version}`));
    const inactive = needs.pins.filter((pin) => !active.has(`${pin.name}@${pin.version}`));
    if (inactive.length > 0) {
      lines.push(
        `These tools aren't turned on: ${inactive.map((pin) => `${pin.name} v${pin.version}`).join(", ")}.`,
      );
    }
  }
  if (lines.length === 0) return null;
  const isKeyIssue =
    refusal?.failure === Schemas.ChatbotConfigFailureEnum.ModelKeyMissing ||
    lines.some((line) => line.startsWith("Add a working model key"));

  return (
    <Alert className="border-0 bg-destructive-soft">
      <AlertTitle className="text-foreground">
        {refusal
          ? isReady
            ? "This version wasn't published"
            : "This version wasn't sent to testing"
          : "This version can't be published yet"}
      </AlertTitle>
      <AlertDescription className="text-subtle-foreground">
        <ul className="list-disc pl-4">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {isKeyIssue && (
          <Link to="/settings/model-keys" className="text-foreground underline">
            Go to Model keys
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

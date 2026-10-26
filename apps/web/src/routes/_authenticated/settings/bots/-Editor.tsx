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
  usePublishVersion,
  useSaveDraft,
} from "./-data";

const { Draft } = Schemas.ChatbotConfigStatusIntEnum;

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
        description={
          isDraft
            ? "A draft. Save your edits, then publish to make it live."
            : "Versions that left draft don't change. Copy one into a new draft to change or roll back to it."
        }
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
          {isDraft && <PublishIssues body={version.body} options={options} refusal={refusal} />}
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

// DEV_NOTE: Draft: Discard and Publish (both confirmed; Publish waits for unsaved edits to be saved, since it publishes
// what is stored). Any other version: Copy to new draft, or Open draft while the bot already has one.
function VersionActions({
  chatbotPublicId,
  version,
  isDirty,
  onRefusal,
}: Schemas.DashboardVersionActionsProps) {
  const navigate = useNavigate();
  const rows = useBotRows();
  const copy = useCopyVersion(chatbotPublicId);
  const publish = usePublishVersion(chatbotPublicId, version.publicId);
  const discard = useDiscardDraft(chatbotPublicId, version.publicId);
  const [confirming, setConfirming] = useState<Schemas.DashboardVersionConfirmEnum | null>(null);
  const draft = rows.data?.chatbots?.find((row) => row.publicId === chatbotPublicId)?.draftConfig;

  if (version.chatbotConfigStatus !== Draft) {
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

  return (
    <>
      <Button
        variant="ghost"
        className="text-subtle-foreground"
        disabled={discard.isPending}
        onClick={() => setConfirming(Schemas.DashboardVersionConfirmEnum.Discard)}
      >
        Discard draft
      </Button>
      <Button
        disabled={isDirty || publish.isPending || version.body === null}
        title={isDirty ? "Save the draft first" : undefined}
        onClick={() => setConfirming(Schemas.DashboardVersionConfirmEnum.Publish)}
      >
        {publish.isPending ? "Publishing…" : "Publish"}
      </Button>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === Schemas.DashboardVersionConfirmEnum.Publish
                ? `Publish v${version.configVersion}?`
                : `Discard v${version.configVersion}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === Schemas.DashboardVersionConfirmEnum.Publish
                ? "It becomes the live version: every conversation uses it from the next message. The current live version is kept, and you can roll back by copying it."
                : "The draft is set aside and can't be edited again. The live version doesn't change."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming === Schemas.DashboardVersionConfirmEnum.Publish) {
                  onRefusal(null);
                  publish.mutate(undefined, {
                    onError: (error) => onRefusal(configRefusalOf(error)),
                  });
                } else {
                  discard.mutate(undefined, {
                    onSuccess: () =>
                      void navigate({ to: "/settings/bots", search: { botId: chatbotPublicId } }),
                  });
                }
                setConfirming(null);
              }}
            >
              {confirming === Schemas.DashboardVersionConfirmEnum.Publish
                ? "Publish"
                : "Discard draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// DEV_NOTE: What would stop the saved draft publishing, seen from here (model keys, turned-on tools, priced models), and
// the last publish's refusal (it checks again under its locks, so it has the last word)
function PublishIssues({ body, options, refusal }: Schemas.DashboardPublishIssuesProps) {
  const lines: string[] = [];
  if (refusal) {
    lines.push(refusal.message ?? "The version wasn't published.");
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
        {refusal ? "This version wasn't published" : "This version can't be published yet"}
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

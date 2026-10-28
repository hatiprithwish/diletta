import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { ArrowsClockwise, Info, Key, Plus } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Alert, AlertDescription } from "@app/ui/components/alert";
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
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import {
  MODEL_KEY_REFUSAL_COPY,
  modelKeyRefusalOf,
  useAddModelKey,
  useModelKeys,
  useRotateModelKey,
} from "./-data";

const KEY_STATUS_TONE: Record<Schemas.CompanySecretStatusIntEnum, Schemas.DashboardChipToneEnum> = {
  [Schemas.CompanySecretStatusIntEnum.Active]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.CompanySecretStatusIntEnum.Invalid]: Schemas.DashboardChipToneEnum.Destructive,
  [Schemas.CompanySecretStatusIntEnum.Revoked]: Schemas.DashboardChipToneEnum.Neutral,
};

const PROVIDERS = Object.values(Schemas.ModelProviderEnum);

// DEV_NOTE: The whole /settings/model-keys body (DESIGN.md dashboard-ModelKeys): why a key is needed, then the keys with
// Add key and Rotate. The test judge card waits for test runs (M5-2).
export function ModelKeysPage() {
  const query = useModelKeys();
  const [isAdding, setIsAdding] = useState(false);
  const modelKeys = query.data?.modelKeys;
  const hasActiveKey = modelKeys?.some(
    (modelKey) => modelKey.status === Schemas.CompanySecretStatusIntEnum.Active,
  );

  return (
    <div className="flex flex-col gap-10">
      <PageHeader
        title="Model keys"
        description="Your provider keys, required for every model call"
      />
      <Alert className="items-center border-0 bg-brand-soft py-4 text-foreground">
        <Info className="text-brand-text" aria-hidden />
        <AlertDescription className="text-body text-foreground">
          {modelKeys && !hasActiveKey
            ? "A model key is required. Add one before you publish a bot: every model call, including test runs, uses your key and is billed by your provider."
            : "A model key is required. Every model call, including test runs, uses your key and is billed by your provider."}
        </AlertDescription>
      </Alert>
      <section className="flex flex-col gap-4" aria-label="Model keys">
        <SectionHeader title="Model keys">
          <Button onClick={() => setIsAdding(true)}>
            <Plus aria-hidden />
            Add key
          </Button>
        </SectionHeader>
        {query.isPending && <Skeleton className="h-32 rounded-xl" aria-label="Loading" />}
        {!query.isPending && !modelKeys && (
          <PageError title="Model keys didn't load" onRetry={() => void query.refetch()} />
        )}
        {modelKeys && modelKeys.length === 0 && (
          <div className="rounded-xl border px-[22px] py-5">
            <p className="text-body text-muted-foreground">
              No model keys yet. Add one from Anthropic, OpenAI or Google.
            </p>
          </div>
        )}
        {modelKeys && modelKeys.length > 0 && (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Provider</TableHead>
                  <TableHead className="px-4">Key</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Last checked</TableHead>
                  <TableHead className="w-28 px-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {modelKeys.map((modelKey) => (
                  <ModelKeyRow key={modelKey.publicId} modelKey={modelKey} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <ModelKeyDialog modelKey={null} isOpen={isAdding} onClose={() => setIsAdding(false)} />
    </div>
  );
}

function ModelKeyRow({ modelKey }: Schemas.DashboardModelKeyRowProps) {
  const [isRotating, setIsRotating] = useState(false);
  return (
    <TableRow>
      <TableCell className="px-4 py-3 text-foreground">
        <span className="flex items-center gap-2">
          <Key className="text-subtle-foreground" aria-hidden />
          {modelKey.providerLabel}
        </span>
      </TableCell>
      <TableCell className="px-4 py-3 font-mono text-mono-value text-muted-foreground">
        {modelKey.lastFourChars ? `…${modelKey.lastFourChars}` : "Hidden"}
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip label={modelKey.statusLabel} tone={KEY_STATUS_TONE[modelKey.status]} />
      </TableCell>
      <TableCell className="px-4 py-3 text-muted-foreground">
        {modelKey.lastValidatedAt
          ? Utilities.formatWhenWithTime(modelKey.lastValidatedAt)
          : "Not checked yet"}
      </TableCell>
      <TableCell className="px-4 py-3 text-right">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsRotating(true)}
          aria-label={`Rotate ${modelKey.providerLabel} key`}
        >
          <ArrowsClockwise aria-hidden />
          Rotate
        </Button>
        <ModelKeyDialog
          modelKey={modelKey}
          isOpen={isRotating}
          onClose={() => setIsRotating(false)}
        />
      </TableCell>
    </TableRow>
  );
}

function secretIssue(value: string): string | undefined {
  return Schemas.ZModelKeySecret.safeParse(value).success ? undefined : "Paste the key.";
}

const errorsOf = (errors: unknown[]) => errors.map((message) => ({ message: String(message) }));

// DEV_NOTE: Add key (modelKey null: provider + key) or Rotate (a new key for that provider). The key is checked with the
// provider before it's saved; a refusal shows in the dialog and nothing is saved. The field is a password input and is
// cleared whenever the dialog closes.
function ModelKeyDialog({ modelKey, isOpen, onClose }: Schemas.DashboardModelKeyDialogProps) {
  const add = useAddModelKey();
  const rotate = useRotateModelKey(modelKey?.publicId ?? "");
  const [refusal, setRefusal] = useState<Schemas.ModelKeyFailureEnum | null>(null);
  const idPrefix = `model-key-${modelKey?.publicId ?? "new"}`;
  const form = useForm({
    defaultValues: {
      provider: modelKey?.provider ?? Schemas.ModelProviderEnum.Anthropic,
      secret: "",
    },
    onSubmit: async ({ value }) => {
      setRefusal(null);
      try {
        if (modelKey) {
          await rotate.mutateAsync({ secret: value.secret });
        } else {
          await add.mutateAsync({ provider: value.provider, secret: value.secret });
        }
      } catch (error) {
        setRefusal(modelKeyRefusalOf(error));
        return;
      }
      close();
    },
  });
  function close() {
    form.reset();
    setRefusal(null);
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {modelKey ? `Rotate ${modelKey.providerLabel} key` : "Add model key"}
            </DialogTitle>
            <DialogDescription>
              {modelKey
                ? "Paste the new key. It's checked with the provider first; the old key stays in use until the new one is saved."
                : "Paste a key from your provider. It's checked with the provider before it's saved, without a billed call."}
            </DialogDescription>
          </DialogHeader>
          {!modelKey && (
            <form.Field name="provider">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={`${idPrefix}-provider`}>Provider</FieldLabel>
                  <Select
                    value={field.state.value}
                    onValueChange={(value) =>
                      field.handleChange(value as Schemas.ModelProviderEnum)
                    }
                  >
                    <SelectTrigger id={`${idPrefix}-provider`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {Schemas.MODEL_PROVIDER_LABEL_MAP[provider]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
          )}
          <form.Field name="secret" validators={{ onChange: ({ value }) => secretIssue(value) }}>
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0 || refusal !== null}>
                <FieldLabel htmlFor={`${idPrefix}-secret`}>Key</FieldLabel>
                <Input
                  id={`${idPrefix}-secret`}
                  name={field.name}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    setRefusal(null);
                    field.handleChange(event.target.value);
                  }}
                  aria-invalid={field.state.meta.errors.length > 0 || refusal !== null}
                />
                <FieldDescription>
                  Only the last four characters are shown after saving.
                </FieldDescription>
                <FieldError
                  errors={
                    refusal
                      ? [{ message: MODEL_KEY_REFUSAL_COPY[refusal] }]
                      : errorsOf(field.state.meta.errors)
                  }
                />
              </Field>
            )}
          </form.Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? "Checking…" : modelKey ? "Check and rotate" : "Check and add"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

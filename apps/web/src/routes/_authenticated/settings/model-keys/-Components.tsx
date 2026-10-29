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
      <AddModelKeyDialog isOpen={isAdding} onClose={() => setIsAdding(false)} />
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
        <RotateModelKeyDialog
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

// DEV_NOTE: The pasted key: a password input, never echoed back after saving
function SecretField({
  id,
  value,
  errors,
  refusal,
  onBlur,
  onChange,
}: Schemas.DashboardSecretFieldProps) {
  const isInvalid = errors.length > 0 || refusal !== null;
  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={id}>Key</FieldLabel>
      <Input
        id={id}
        name="secret"
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        value={value}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={isInvalid}
      />
      <FieldDescription>Only the last four characters are shown after saving.</FieldDescription>
      <FieldError errors={refusal ? [{ message: refusal }] : Utilities.toFieldErrors(errors)} />
    </Field>
  );
}

// DEV_NOTE: Add key: a provider and its key, checked with the provider before it's saved. The form is mounted only while
// the dialog is open, so the key never stays in the field. A refusal shows in the dialog (the hook doesn't toast it).
function AddModelKeyDialog({ isOpen, onClose }: Schemas.DashboardAddModelKeyDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{isOpen && <AddModelKeyForm onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

function AddModelKeyForm({ onClose }: Pick<Schemas.DashboardAddModelKeyDialogProps, "onClose">) {
  const add = useAddModelKey();
  const [refusal, setRefusal] = useState<Schemas.ModelKeyFailureEnum | null>(null);
  const form = useForm({
    defaultValues: { provider: Schemas.ModelProviderEnum.Anthropic, secret: "" },
    onSubmit: async ({ value }) => {
      setRefusal(null);
      try {
        await add.mutateAsync({ provider: value.provider, secret: value.secret });
      } catch (error) {
        setRefusal(modelKeyRefusalOf(error));
        return;
      }
      onClose();
    },
  });

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add model key</DialogTitle>
        <DialogDescription>
          Paste a key from your provider. It's checked with the provider before it's saved, without
          a billed call.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="provider">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="model-key-new-provider">Provider</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(value) => {
                setRefusal(null);
                field.handleChange(value as Schemas.ModelProviderEnum);
              }}
            >
              <SelectTrigger id="model-key-new-provider" className="w-full">
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
      <form.Field name="secret" validators={{ onChange: ({ value }) => secretIssue(value) }}>
        {(field) => (
          <SecretField
            id="model-key-new-secret"
            value={field.state.value}
            errors={field.state.meta.errors.map(String)}
            refusal={refusal ? MODEL_KEY_REFUSAL_COPY[refusal] : null}
            onBlur={field.handleBlur}
            onChange={(value) => {
              setRefusal(null);
              field.handleChange(value);
            }}
          />
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Checking…" : "Check and add"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

// DEV_NOTE: Rotate: a new key for this key's provider, checked first; the old key stays in use until the new one saves
function RotateModelKeyDialog({
  modelKey,
  isOpen,
  onClose,
}: Schemas.DashboardRotateModelKeyDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {isOpen && <RotateModelKeyForm modelKey={modelKey} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function RotateModelKeyForm({
  modelKey,
  onClose,
}: Omit<Schemas.DashboardRotateModelKeyDialogProps, "isOpen">) {
  const rotate = useRotateModelKey(modelKey.publicId);
  const [refusal, setRefusal] = useState<Schemas.ModelKeyFailureEnum | null>(null);
  const form = useForm({
    defaultValues: { secret: "" },
    onSubmit: async ({ value }) => {
      setRefusal(null);
      try {
        await rotate.mutateAsync({ secret: value.secret });
      } catch (error) {
        setRefusal(modelKeyRefusalOf(error));
        return;
      }
      onClose();
    },
  });

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rotate {modelKey.providerLabel} key</DialogTitle>
        <DialogDescription>
          Paste the new key. It's checked with the provider first; the old key stays in use until
          the new one is saved.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="secret" validators={{ onChange: ({ value }) => secretIssue(value) }}>
        {(field) => (
          <SecretField
            id={`model-key-${modelKey.publicId}-secret`}
            value={field.state.value}
            errors={field.state.meta.errors.map(String)}
            refusal={refusal ? MODEL_KEY_REFUSAL_COPY[refusal] : null}
            onBlur={field.handleBlur}
            onChange={(value) => {
              setRefusal(null);
              field.handleChange(value);
            }}
          />
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Checking…" : "Check and rotate"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

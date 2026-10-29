import { useForm } from "@tanstack/react-form";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@app/ui/components/field";
import { Textarea } from "@app/ui/components/textarea";

// DEV_NOTE: Edit a connection's allowed origins (M4-9 Security, M4-10 Settings › Connections): one write path, the
// Security route, which the caller's onSave sends. The dialog awaits it and closes on success; the caller's mutation
// toasts either way.
export function OriginsDialog({
  connection,
  isOpen,
  onClose,
  onSave,
}: Schemas.DashboardOriginsDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {isOpen && <OriginsForm connection={connection} onClose={onClose} onSave={onSave} />}
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
  onSave,
}: Omit<Schemas.DashboardOriginsDialogProps, "isOpen">) {
  const form = useForm({
    defaultValues: { origins: connection.allowedOrigins.join("\n") },
    onSubmit: async ({ value }) => {
      await onSave(toOrigins(value.origins));
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

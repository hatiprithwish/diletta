import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { Plus, X } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@app/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
import { Textarea } from "@app/ui/components/textarea";
import Utilities from "@/utils";

const { User, Assistant } = Schemas.EvalCaseMessageRoleEnum;

function nameIssue(value: string): string | undefined {
  return Schemas.ZEvalCaseName.safeParse(value).success
    ? undefined
    : `Give the test a name, up to ${Schemas.EVAL_CASE_NAME_MAX_CHARS} characters.`;
}

function messageIssue(value: string): string | undefined {
  return Schemas.ZEvalCaseMessage.shape.text.safeParse(value).success
    ? undefined
    : `Keep each message between 1 and ${Utilities.formatCount(Schemas.EVAL_CASE_MESSAGE_MAX_CHARS)} characters.`;
}

// DEV_NOTE: The conversation as a whole: it ends with the user's question (the chatbot under test answers it)
function messagesIssue(messages: Schemas.EvalCaseMessage[]): string | undefined {
  if (messages.length === 0) return "Add the user's question.";
  if (messages.at(-1)?.role !== User) return "End with the user's question.";
  return undefined;
}

function rubricIssue(value: string): string | undefined {
  return Schemas.ZEvalCaseRubric.safeParse(value).success
    ? undefined
    : `Say what a good reply does, up to ${Utilities.formatCount(Schemas.EVAL_CASE_RUBRIC_MAX_CHARS)} characters.`;
}

const errorsOf = (errors: unknown[]) => errors.map((message) => ({ message: String(message) }));

// DEV_NOTE: A test case's form, inside a Dialog: name, the conversation (oldest first, ending with the user's question)
// and what a good reply does. canEditMessages adds and removes messages (New case, Edit); off, the messages are only
// edited in place (Quality's review of a rewrite). The case is saved as the admin sees it.
export function EvalCaseForm({
  defaultValues,
  canEditMessages,
  title,
  description,
  submitLabel,
  onSubmit,
  onCancel,
}: Schemas.DashboardEvalCaseFormProps) {
  // DEV_NOTE: One stable key per message, added and removed with it, so a textarea keeps its focus and state
  const [messageKeys, setMessageKeys] = useState(() =>
    defaultValues.messages.map(() => crypto.randomUUID()),
  );
  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      await onSubmit(value);
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
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <form.Field name="name" validators={{ onChange: ({ value }) => nameIssue(value) }}>
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor="test-name">Name</FieldLabel>
            <Input
              id="test-name"
              name={field.name}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            <FieldError errors={errorsOf(field.state.meta.errors)} />
          </Field>
        )}
      </form.Field>
      <form.Field name="messages" validators={{ onChange: ({ value }) => messagesIssue(value) }}>
        {(messagesField) => {
          const messages = messagesField.state.value;
          const add = (role: Schemas.EvalCaseMessageRoleEnum) => {
            messagesField.pushValue({ role, text: "" });
            setMessageKeys((keys) => [...keys, crypto.randomUUID()]);
          };
          const remove = (index: number) => {
            messagesField.removeValue(index);
            setMessageKeys((keys) => keys.filter((_, keyIndex) => keyIndex !== index));
          };
          return (
            <div className="flex flex-col gap-3">
              <p className="text-body font-medium text-foreground">Conversation</p>
              {messages.map((message, index) => (
                <div key={messageKeys[index]} className="flex items-start gap-2">
                  <form.Field
                    name={`messages[${index}].text`}
                    validators={{ onChange: ({ value }) => messageIssue(value) }}
                  >
                    {(field) => (
                      <Field data-invalid={field.state.meta.errors.length > 0} className="flex-1">
                        <FieldLabel
                          htmlFor={`test-message-${index}`}
                          className="text-muted-foreground"
                        >
                          {message.role === User ? "User" : "Assistant"}
                        </FieldLabel>
                        <Textarea
                          id={`test-message-${index}`}
                          name={field.name}
                          rows={2}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                          aria-invalid={field.state.meta.errors.length > 0}
                        />
                        <FieldError errors={errorsOf(field.state.meta.errors)} />
                      </Field>
                    )}
                  </form.Field>
                  {canEditMessages && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="mt-6 text-subtle-foreground"
                      disabled={messages.length === 1}
                      onClick={() => remove(index)}
                      aria-label={`Remove message ${index + 1}`}
                    >
                      <X />
                    </Button>
                  )}
                </div>
              ))}
              {canEditMessages && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={messages.length >= Schemas.EVAL_CASE_MAX_MESSAGES}
                    onClick={() => add(User)}
                  >
                    <Plus aria-hidden />
                    User message
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={messages.length >= Schemas.EVAL_CASE_MAX_MESSAGES}
                    onClick={() => add(Assistant)}
                  >
                    <Plus aria-hidden />
                    Assistant reply
                  </Button>
                </div>
              )}
              <FieldError errors={errorsOf(messagesField.state.meta.errors)} />
            </div>
          );
        }}
      </form.Field>
      <form.Field name="rubric" validators={{ onChange: ({ value }) => rubricIssue(value) }}>
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor="test-rubric">What a good reply does</FieldLabel>
            <Textarea
              id="test-rubric"
              name={field.name}
              rows={3}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            <FieldError errors={errorsOf(field.state.meta.errors)} />
          </Field>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Saving…" : submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

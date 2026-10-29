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

// DEV_NOTE: isOptional = the case has other checks, so a blank rubric (no judge) still leaves something to check
function rubricIssue(value: string, isOptional: boolean): string | undefined {
  if (isOptional && value.trim() === "") return undefined;
  return Schemas.ZEvalCaseRubric.safeParse(value).success
    ? undefined
    : `Say what a good reply does, up to ${Utilities.formatCount(Schemas.EVAL_CASE_RUBRIC_MAX_CHARS)} characters.`;
}

function hasChecks(checks: Schemas.EvalCaseChecks | undefined): checks is Schemas.EvalCaseChecks {
  if (!checks) return false;
  return (
    checks.rules.length +
      checks.toolCalls.length +
      checks.forbiddenTools.length +
      checks.readbacks.length >
    0
  );
}

// DEV_NOTE: Expected values as the case stores them (JSON), name: value
function valuesText(values: Record<string, Schemas.EvalCaseJsonValue>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}: ${JSON.stringify(value)}`)
    .join(", ");
}

// DEV_NOTE: Stable keys from content for a list that never changes while shown; a repeat gets its count added
function keyedByContent<T>(items: T[]): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const content = JSON.stringify(item);
    const count = seen.get(content) ?? 0;
    seen.set(content, count + 1);
    return { key: `${content}#${count}`, item };
  });
}

// DEV_NOTE: The case's checks besides the rubric, read-only (they're written with the case, never on this form)
function EvalCaseChecksList({ checks }: Schemas.DashboardEvalCaseChecksProps) {
  const usesTag = JSON.stringify(checks).includes(Schemas.EVAL_CASE_TAG_PLACEHOLDER);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium text-foreground">Also checks</p>
      <ul className="flex flex-col gap-1.5 text-body text-foreground">
        {keyedByContent(checks.rules).map(({ key, item: rule }) => (
          <li key={key} className="break-words">
            {rule.kind === Schemas.EvalCaseRuleKindEnum.Contains
              ? "The reply includes "
              : "The reply never includes "}
            “{rule.text}”
          </li>
        ))}
        {keyedByContent(checks.toolCalls).map(({ key, item: call }) => (
          <li key={key} className="break-words">
            Calls <span className="font-mono text-mono-value">{call.toolName}</span>
            {Object.keys(call.args).length > 0 && (
              <>
                {" with "}
                <span className="font-mono text-mono-value">{valuesText(call.args)}</span>
              </>
            )}
          </li>
        ))}
        {checks.forbiddenTools.map((toolName) => (
          <li key={`forbidden-${toolName}`}>
            Never calls <span className="font-mono text-mono-value">{toolName}</span>
          </li>
        ))}
        {checks.readbacks.map((readback) => (
          <li key={`readback-${readback.toolName}`} className="break-words">
            After the run, the record{" "}
            <span className="font-mono text-mono-value">{readback.toolName}</span> changed shows{" "}
            <span className="font-mono text-mono-value">{valuesText(readback.expect)}</span>
          </li>
        ))}
      </ul>
      {usesTag && (
        <p className="text-caption text-muted-foreground">
          <span className="font-mono text-mono-value">{Schemas.EVAL_CASE_TAG_PLACEHOLDER}</span>{" "}
          becomes a new name in every attempt.
        </p>
      )}
    </div>
  );
}

const errorsOf = (errors: unknown[]) => errors.map((message) => ({ message: String(message) }));

// DEV_NOTE: A test case's form, inside a Dialog: name, the conversation (oldest first, ending with the user's question)
// and what a good reply does. canEditMessages adds and removes messages (New case, Edit); off, the messages are only
// edited in place (Quality's review of a rewrite). The case is saved as the admin sees it; its other checks (checks)
// are only listed, and make the rubric optional.
export function EvalCaseForm({
  defaultValues,
  checks,
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
  const isRubricOptional = hasChecks(checks);
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
      <form.Field
        name="rubric"
        validators={{ onChange: ({ value }) => rubricIssue(value, isRubricOptional) }}
      >
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor="test-rubric">
              {isRubricOptional ? "What a good reply does (optional)" : "What a good reply does"}
            </FieldLabel>
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
      {hasChecks(checks) && <EvalCaseChecksList checks={checks} />}
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

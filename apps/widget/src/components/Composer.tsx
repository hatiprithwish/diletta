import type { FormEvent, KeyboardEvent } from "react";
import { ArrowUp } from "@phosphor-icons/react";
import { Textarea } from "@app/ui/components/textarea";
import { cn } from "@app/ui/lib/utils";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The message box: Enter sends, Shift+Enter adds a line; disabled while the chatbot is unavailable, and send
// is off while a reply is running. Text over WIDGET_MESSAGE_MAX_CHARS can't be typed (the DO refuses it anyway).
export default function Composer({
  value,
  isDisabled,
  isBusy,
  onChange,
  onSend,
}: Schemas.WidgetComposerProps) {
  const canSend = !isDisabled && !isBusy && value.trim().length > 0;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSend) onSend(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 px-3.5 pt-2.5 pb-3">
      <div
        className={cn(
          "flex items-end gap-2 rounded-[14px] border border-border py-1.25 pr-1.25 pl-3.5",
          isDisabled ? "bg-muted" : "bg-background",
        )}
      >
        <label htmlFor="diletta-widget-message" className="sr-only">
          Message
        </label>
        <Textarea
          id="diletta-widget-message"
          rows={1}
          value={value}
          disabled={isDisabled}
          maxLength={Schemas.WIDGET_MESSAGE_MAX_CHARS}
          placeholder={isDisabled ? "Assistant unavailable" : "Ask anything"}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-32 min-h-8.5 resize-none border-0 bg-transparent px-0 py-1.75 text-sm shadow-none focus-visible:ring-0 disabled:opacity-100 dark:bg-transparent md:text-sm"
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!canSend}
          className={cn(
            "flex size-8.5 shrink-0 items-center justify-center rounded-lg transition-colors",
            canSend ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          <ArrowUp className="size-4" weight="bold" />
        </button>
      </div>
      <span className="px-1 text-[11.5px] text-muted-foreground">
        AI assistant. Changes to your data need your approval.
      </span>
    </form>
  );
}

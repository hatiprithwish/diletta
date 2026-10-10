import { MagnifyingGlass, Sparkle } from "@phosphor-icons/react";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: A new chat (widget-Welcome): the configured greeting and up to 3 suggestions. The greeting's first line is
// the heading and the rest, if any, the paragraph under it, so a company can write both in one field.
export default function Welcome({ greeting, suggestions, onPick }: Schemas.WidgetWelcomeProps) {
  const [heading = "", ...rest] = greeting.split("\n");
  const intro = rest.join("\n").trim();
  return (
    <div className="flex flex-col gap-5.5 pb-3">
      <div className="flex flex-col gap-2">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Sparkle className="size-5" />
        </span>
        <h2 className="mt-1.5 text-xl font-semibold tracking-tight">{heading.trim()}</h2>
        {intro && <p className="text-sm leading-normal text-subtle-foreground">{intro}</p>}
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => onPick(suggestion)}
              className="flex min-h-11 w-full items-center gap-2.5 rounded-xl border border-border bg-background px-3.5 text-left text-body transition-colors hover:bg-muted"
            >
              <MagnifyingGlass className="size-4 shrink-0 text-muted-foreground" />
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

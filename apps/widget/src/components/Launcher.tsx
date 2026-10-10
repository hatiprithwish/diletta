import { ChatCircle } from "@phosphor-icons/react";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: The closed widget (host-Launcher): a 52px lime circle with the optional label pill beside it, both open
// the panel
export default function Launcher({ label, chatbotName, onOpen }: Schemas.WidgetLauncherProps) {
  return (
    <div className="flex items-center gap-2.5">
      {label && (
        <button
          type="button"
          onClick={onOpen}
          className="rounded-full bg-background px-3.5 py-2 text-body text-foreground shadow-float"
        >
          {label}
        </button>
      )}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${chatbotName}`}
        className="flex size-13 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-float transition-transform hover:scale-105"
      >
        <ChatCircle className="size-5.5" weight="regular" />
      </button>
    </div>
  );
}

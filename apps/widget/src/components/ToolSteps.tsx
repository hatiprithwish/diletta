import { Check, X } from "@phosphor-icons/react";
import { cn } from "@app/ui/lib/utils";
import * as Schemas from "@app/schemas";

// DEV_NOTE: A reply's tool calls (widget-Streaming): done ✓, running spinner, failed ✕, with a short result on the right
export default function ToolSteps({ steps }: Schemas.WidgetToolStepsProps) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-muted bg-surface-subtle px-3 py-2.5 text-widget-row">
      {steps.map((step) => (
        <div
          key={step.id}
          className={cn(
            "flex items-center gap-2.5",
            step.state === Schemas.WidgetToolStepStateEnum.Running
              ? "text-foreground"
              : "text-subtle-foreground",
          )}
        >
          {step.state === Schemas.WidgetToolStepStateEnum.Done && (
            <Check className="size-3.5 shrink-0 text-brand-text" weight="bold" />
          )}
          {step.state === Schemas.WidgetToolStepStateEnum.Failed && (
            <X className="size-3.5 shrink-0 text-muted-foreground" weight="bold" />
          )}
          {step.state === Schemas.WidgetToolStepStateEnum.Running && (
            <span
              role="progressbar"
              aria-label={step.label}
              className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-brand-text"
            />
          )}
          <span>{step.label}</span>
          {step.detail && (
            <span className="ml-auto text-xs text-muted-foreground">{step.detail}</span>
          )}
        </div>
      ))}
    </div>
  );
}

import {
  ArrowCounterClockwise,
  Check,
  Checks,
  Prohibit,
  UserFocus,
  X,
} from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";

// DEV_NOTE: How one record's change stands once the user answered (DESIGN.md §8: say what did NOT happen). The card's
// header tells the whole card's story (verified, undone, needs a person: M3-6); this is the record's own line.
const OUTCOME_TEXT: Record<Schemas.WidgetChangeOutcomeEnum, string> = {
  [Schemas.WidgetChangeOutcomeEnum.Waiting]: "Waiting for your approval",
  [Schemas.WidgetChangeOutcomeEnum.Saving]: "Saving…",
  [Schemas.WidgetChangeOutcomeEnum.Saved]: "Saved. Checking it…",
  [Schemas.WidgetChangeOutcomeEnum.Verified]: "Saved and checked",
  [Schemas.WidgetChangeOutcomeEnum.Undoing]: "Didn't save as expected. Undoing…",
  [Schemas.WidgetChangeOutcomeEnum.Undone]: "Undone. Nothing changed.",
  [Schemas.WidgetChangeOutcomeEnum.Rejected]: "Rejected. Nothing changed.",
  [Schemas.WidgetChangeOutcomeEnum.Expired]: "Expired. Nothing changed.",
  [Schemas.WidgetChangeOutcomeEnum.Failed]: "Couldn't save. Nothing changed.",
  [Schemas.WidgetChangeOutcomeEnum.NeedsPerson]: "Needs a person to check",
};

export default function ChangeOutcome({ outcome }: Schemas.WidgetChangeOutcomeProps) {
  if (outcome === Schemas.WidgetChangeOutcomeEnum.Waiting) return null;
  return (
    <span
      role="status"
      className="flex items-center gap-1.5 text-widget-row text-subtle-foreground"
    >
      {(outcome === Schemas.WidgetChangeOutcomeEnum.Saving ||
        outcome === Schemas.WidgetChangeOutcomeEnum.Undoing) && (
        <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-border border-t-brand-text" />
      )}
      {outcome === Schemas.WidgetChangeOutcomeEnum.Saved && (
        <Check className="size-3.5 shrink-0 text-brand-text" weight="bold" />
      )}
      {outcome === Schemas.WidgetChangeOutcomeEnum.Verified && (
        <Checks className="size-3.5 shrink-0 text-brand-text" weight="bold" />
      )}
      {outcome === Schemas.WidgetChangeOutcomeEnum.Undone && (
        <ArrowCounterClockwise className="size-3.5 shrink-0 text-warning" />
      )}
      {(outcome === Schemas.WidgetChangeOutcomeEnum.Rejected ||
        outcome === Schemas.WidgetChangeOutcomeEnum.Expired) && (
        <Prohibit className="size-3.5 shrink-0" />
      )}
      {outcome === Schemas.WidgetChangeOutcomeEnum.Failed && (
        <X className="size-3.5 shrink-0" weight="bold" />
      )}
      {outcome === Schemas.WidgetChangeOutcomeEnum.NeedsPerson && (
        <UserFocus className="size-3.5 shrink-0" />
      )}
      {OUTCOME_TEXT[outcome]}
    </span>
  );
}

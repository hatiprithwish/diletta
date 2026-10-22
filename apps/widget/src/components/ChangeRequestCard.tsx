import { useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  Check,
  Clock,
  PencilSimple,
  Plus,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { cn } from "@app/ui/lib/utils";
import { Button } from "@app/ui/components/button";
import * as Schemas from "@app/schemas";
import ChangeOutcome from "@/components/ChangeOutcome";
import ChangeRequestBulk from "@/components/ChangeRequestBulk";
import ChangeRequestEditor from "@/components/ChangeRequestEditor";
import DiffLine from "@/components/DiffLine";

// DEV_NOTE: A review card (DESIGN.md §7 Approval / Editing / Bulk): 1px border, radius 12, a header with the kind's
// icon, the title and one line, one row per record (mono id + its diff), and the footer actions. Renders the view
// only; every action goes up (useChangeReview). The buttons wait while an answer or an edit is on its way. A settled
// card (M3-6) takes its tone's icon: Verified ✓, Changes undone (with what the check found), Needs a person (which
// records saved, which is flagged). A card with records the user can still undo (M3-7, widget-Verified) shows Undo and
// "Undo available until HH:MM", hidden once that time passes.
const KIND_ICON = {
  [Schemas.ChangeRequestKindEnum.Update]: PencilSimple,
  [Schemas.ChangeRequestKindEnum.Create]: Plus,
  [Schemas.ChangeRequestKindEnum.Delete]: Trash,
};

const TONE_ICON = {
  [Schemas.WidgetChangeCardToneEnum.Verified]: { Icon: Check, className: "text-brand-text" },
  [Schemas.WidgetChangeCardToneEnum.Undone]: {
    Icon: ArrowCounterClockwise,
    className: "text-warning",
  },
  [Schemas.WidgetChangeCardToneEnum.NeedsPerson]: {
    Icon: Warning,
    className: "text-destructive",
  },
};

const EXPIRY_NOTE = "This request expires if it isn't approved soon.";

// DEV_NOTE: The undo window's end as a clock time (DESIGN.md widget-Verified: "16:42"), in the visitor's time zone
const UNDO_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// DEV_NOTE: Whether the undo window (epoch ms) is still open, re-rendering when it ends
function useIsBefore(until: number | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null || until <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), until - Date.now());
    return () => clearTimeout(timer);
  }, [until]);
  return until !== null && until > now;
}

export default function ChangeRequestCard({ card, actions }: Schemas.WidgetChangeCardProps) {
  const toneIcon =
    card.tone === Schemas.WidgetChangeCardToneEnum.Review ||
    card.tone === Schemas.WidgetChangeCardToneEnum.Plain
      ? null
      : TONE_ICON[card.tone];
  const Icon = toneIcon?.Icon ?? (card.kind ? KIND_ICON[card.kind] : PencilSimple);
  const { isSending } = card;
  const isEditing = card.stage === Schemas.WidgetChangeCardStageEnum.Editing;
  const isSettled = card.stage === Schemas.WidgetChangeCardStageEnum.Settled;
  const isBulk = card.layout === Schemas.WidgetChangeCardLayoutEnum.Bulk;
  const canUndo = useIsBefore(card.undoUntil) && card.undoCount > 0 && !isEditing;

  return (
    <section
      aria-label={card.title}
      aria-busy={isSending}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-background"
    >
      <header className="flex gap-3 px-3.5 pt-3.5 pb-3">
        <Icon
          className={cn("mt-0.5 size-4 shrink-0", toneIcon?.className ?? "text-brand-text")}
          weight="bold"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-body font-semibold">{card.title}</h3>
          <p className="text-widget-row leading-normal text-subtle-foreground">{card.subtitle}</p>
        </div>
      </header>

      {card.mismatchLines.length > 0 && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 border-t border-muted px-3.5 py-3 text-widget-row">
          {card.mismatchLines.map((line) => (
            <div key={`${line.label ?? ""}:${line.field}`} className="contents">
              <dt className="text-subtle-foreground">Expected</dt>
              <dd className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                {line.label && (
                  <span className="font-mono text-mono-value text-subtle-foreground">
                    {line.label}
                  </span>
                )}
                <span className="font-mono text-mono-value text-subtle-foreground">
                  {line.field}
                </span>
                <span aria-hidden className="text-subtle-foreground">
                  →
                </span>
                <span className="rounded bg-diff-new px-1.5 text-foreground">
                  {line.expected ?? "empty"}
                </span>
              </dd>
              <dt className="text-subtle-foreground">Found</dt>
              <dd className="text-foreground">{line.found ?? "empty"}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.notes.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-muted px-3.5 py-3">
          {card.notes.map((note) => (
            <p key={note} className="text-widget-row leading-normal text-foreground">
              {note}
            </p>
          ))}
        </div>
      )}

      {isEditing ? (
        <ChangeRequestEditor card={card} actions={actions} />
      ) : isBulk ? (
        <ChangeRequestBulk card={card} actions={actions} />
      ) : (
        <ul className="flex flex-col">
          {card.records.map((record) => (
            <li
              key={record.changeRequestPublicId}
              className="flex flex-col gap-1.5 border-t border-muted px-3.5 py-3"
            >
              <span className="flex items-baseline gap-2">
                {record.label && (
                  <span className="font-mono text-mono-value text-foreground">{record.label}</span>
                )}
                {record.wasEdited && (
                  <span className="text-widget-note text-muted-foreground">Edited by you</span>
                )}
              </span>
              {record.isProposed && !record.isIncluded ? (
                <p className="text-widget-row text-muted-foreground">
                  Removed. This record stays as it is.
                </p>
              ) : (
                record.lines.map((line) => <DiffLine key={line.field} line={line} />)
              )}
              <ChangeOutcome outcome={record.outcome} />
            </li>
          ))}
        </ul>
      )}

      {!isSettled && !isEditing && (
        <footer className="flex flex-col gap-2 border-t border-muted px-3.5 py-3">
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => actions.onApprove(card.id)}
              disabled={isSending || card.includedCount === 0}
              className="text-body"
            >
              <Check weight="bold" />
              {card.approveLabel}
            </Button>
            {card.canEdit && (
              <Button
                variant="outline"
                onClick={() => actions.onEdit(card.id)}
                disabled={isSending}
                className="text-body"
              >
                <PencilSimple />
                Edit
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => actions.onReject(card.id)}
              disabled={isSending}
              className="text-body"
            >
              <X />
              Reject
            </Button>
          </div>
          <p className="text-widget-note text-muted-foreground">{EXPIRY_NOTE}</p>
        </footer>
      )}
      {canUndo && card.undoUntil !== null && (
        <footer className="flex flex-wrap items-center gap-2.5 border-t border-muted px-3 py-2.5">
          <Button
            variant="outline"
            onClick={() => actions.onUndo(card.id)}
            disabled={isSending}
            className="text-body"
          >
            <ArrowCounterClockwise />
            Undo
          </Button>
          <span className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <Clock className="size-3.5 shrink-0" />
            Undo available until {UNDO_TIME_FORMAT.format(card.undoUntil)}
          </span>
        </footer>
      )}
      {card.notice && (
        <p
          role="alert"
          className="border-t border-muted px-3.5 py-2.5 text-caption text-muted-foreground"
        >
          {card.notice}
        </p>
      )}
    </section>
  );
}

import { Check, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import { Button } from "@app/ui/components/button";
import * as Schemas from "@app/schemas";
import ChangeOutcome from "@/components/ChangeOutcome";
import ChangeRequestBulk from "@/components/ChangeRequestBulk";
import ChangeRequestEditor from "@/components/ChangeRequestEditor";
import DiffLine from "@/components/DiffLine";

// DEV_NOTE: A review card (DESIGN.md §7 Approval / Editing / Bulk): 1px border, radius 12, a header with the kind's
// icon, the title and one line, one row per record (mono id + its diff), and the footer actions. Renders the view
// only; every action goes up (useChangeReview). The buttons wait while an answer or an edit is on its way.
const KIND_ICON = {
  [Schemas.ChangeRequestKindEnum.Update]: PencilSimple,
  [Schemas.ChangeRequestKindEnum.Create]: Plus,
  [Schemas.ChangeRequestKindEnum.Delete]: Trash,
};

const EXPIRY_NOTE = "This request expires if it isn't approved soon.";

export default function ChangeRequestCard({ card, actions }: Schemas.WidgetChangeCardProps) {
  const Icon = card.kind ? KIND_ICON[card.kind] : PencilSimple;
  const { isSending } = card;
  const isEditing = card.stage === Schemas.WidgetChangeCardStageEnum.Editing;
  const isSettled = card.stage === Schemas.WidgetChangeCardStageEnum.Settled;
  const isBulk = card.layout === Schemas.WidgetChangeCardLayoutEnum.Bulk;

  return (
    <section
      aria-label={card.title}
      aria-busy={isSending}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-background"
    >
      <header className="flex gap-3 px-3.5 pt-3.5 pb-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-brand-text" weight="bold" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-body font-semibold">{card.title}</h3>
          <p className="text-widget-row leading-normal text-subtle-foreground">{card.subtitle}</p>
        </div>
      </header>

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

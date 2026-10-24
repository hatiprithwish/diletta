import * as Schemas from "@app/schemas";

const Action = Schemas.ChangeRequestEntityActionEnum;
const Tone = Schemas.ChangeRequestTimelineToneEnum;

// DEV_NOTE: The dashboard's words for a change's steps (DESIGN.md §8: plain words, never an internal name or a record's
// values). "Your app" is the company's own app, as in CHANGE_REQUEST_ERROR_LABEL_MAP.
const TIMELINE_TEXT = {
  proposed: "Proposed",
  edited: "Edited",
  approvedAutomatically: "Approved automatically",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired before anyone approved it",
  committing: "Saving in your app",
  committingAgain: "Saving in your app again",
  committed: "Saved in your app",
  failed: "Not saved",
  needsHuman: "Needs a person",
  verified: "Checked: your app shows the change",
  mismatch: "Check failed: your app shows other values",
  undoing: "Undoing the change",
  undoAsked: "Undo asked",
  undoNotSent: "Undo not sent. Nothing changed",
  undone: "Changes undone",
  undoneBy: "Undone",
  resolved: "Marked resolved",
  someone: { admin: "an admin", user: "the user" },
} as const;

// DEV_NOTE: A change's timeline from its activity_log events (M4-5), pure so it is unit-tested on its own: one step per
// event, oldest first, in plain words with the actor's name where a person acted. Each event's detail is read through
// Schemas.ZChangeRequestEventDetail (an unreadable one reads as empty); an action this build doesn't know is left out.
export default class ChangeRequestTimelineProvider {
  static timeline(rows: Schemas.ActivityLogTimelineRow[]): Schemas.ChangeRequestTimelineEntry[] {
    const entries: Schemas.ChangeRequestTimelineEntry[] = [];
    let previousAction: string | null = null;
    for (const row of rows) {
      const step = ChangeRequestTimelineProvider.step(row, previousAction);
      previousAction = row.entityAction;
      if (step) entries.push({ ...step, createdAt: row.createdAt.toISOString() });
    }
    return entries;
  }

  private static step(
    row: Schemas.ActivityLogTimelineRow,
    previousAction: string | null,
  ): Omit<Schemas.ChangeRequestTimelineEntry, "createdAt"> | null {
    const parsed = Schemas.ZChangeRequestEventDetail.safeParse(row.detail);
    const detail: Schemas.ChangeRequestEventDetail = parsed.success ? parsed.data : {};
    const by = (text: string) => `${text} by ${ChangeRequestTimelineProvider.actorName(row)}`;
    const isPerson =
      row.actorType === Schemas.ActivityLogActorTypeIntEnum.ChatbotUser ||
      row.actorType === Schemas.ActivityLogActorTypeIntEnum.Admin;

    switch (row.entityAction) {
      case Action.Proposed:
        return { label: TIMELINE_TEXT.proposed, tone: Tone.Neutral };
      case Action.Edited:
        return { label: by(TIMELINE_TEXT.edited), tone: Tone.Neutral };
      case Action.Approved:
        if (detail.isAutomatic)
          return { label: TIMELINE_TEXT.approvedAutomatically, tone: Tone.Success };
        return {
          label: isPerson ? by(TIMELINE_TEXT.approved) : TIMELINE_TEXT.approved,
          tone: Tone.Success,
        };
      case Action.Rejected:
        return {
          label: isPerson ? by(TIMELINE_TEXT.rejected) : TIMELINE_TEXT.rejected,
          tone: Tone.Neutral,
        };
      case Action.Expired:
        return { label: TIMELINE_TEXT.expired, tone: Tone.Neutral };
      case Action.Committing:
        // DEV_NOTE: A commit resumed after an eviction marks Committing again (its own event): a second try
        return {
          label:
            previousAction === Action.Committing
              ? TIMELINE_TEXT.committingAgain
              : TIMELINE_TEXT.committing,
          tone: Tone.Neutral,
        };
      case Action.Committed:
        return { label: TIMELINE_TEXT.committed, tone: Tone.Success };
      case Action.Failed:
        return {
          label: ChangeRequestTimelineProvider.withReason(TIMELINE_TEXT.failed, detail),
          tone: Tone.Destructive,
        };
      case Action.NeedsHuman:
        return {
          label: ChangeRequestTimelineProvider.withReason(TIMELINE_TEXT.needsHuman, detail),
          tone: Tone.Destructive,
        };
      case Action.Verified:
        return { label: TIMELINE_TEXT.verified, tone: Tone.Success };
      case Action.Mismatch:
        return { label: TIMELINE_TEXT.mismatch, tone: Tone.Destructive };
      case Action.Undoing:
        return {
          label: detail.isUserUndo ? by(TIMELINE_TEXT.undoAsked) : TIMELINE_TEXT.undoing,
          tone: Tone.Neutral,
        };
      case Action.UndoNotSent:
        return { label: TIMELINE_TEXT.undoNotSent, tone: Tone.Neutral };
      case Action.Undone:
        return {
          label: isPerson ? by(TIMELINE_TEXT.undoneBy) : TIMELINE_TEXT.undone,
          tone: Tone.Success,
        };
      case Action.Resolved:
        return { label: by(TIMELINE_TEXT.resolved), tone: Tone.Success };
      default:
        return null;
    }
  }

  // DEV_NOTE: The actor's name, or who they were when it is unknown (none sent, erased, or the row is gone)
  private static actorName(row: Schemas.ActivityLogTimelineRow): string {
    if (row.actorName) return row.actorName;
    return row.actorType === Schemas.ActivityLogActorTypeIntEnum.Admin
      ? TIMELINE_TEXT.someone.admin
      : TIMELINE_TEXT.someone.user;
  }

  // DEV_NOTE: "<step>: <why>" when the event says why (errorCode, or reason on older events), in the words of
  // CHANGE_REQUEST_ERROR_LABEL_MAP; an unknown code reads as ServerError's
  private static withReason(text: string, detail: Schemas.ChangeRequestEventDetail): string {
    const code = detail.errorCode ?? detail.reason ?? null;
    const { errorLabel } = Schemas.changeRequestErrorOf(code);
    return errorLabel
      ? `${text}: ${errorLabel.charAt(0).toLowerCase()}${errorLabel.slice(1)}`
      : text;
  }
}

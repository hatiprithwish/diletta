import { isToolUIPart } from "ai";
import type { UIMessage, getToolName } from "ai";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The review cards (M3-5) from Think's transcript and the change requests the DO sent (change_request
// frames, parsed). Pure. A change request belongs to the reply whose tool call proposed it: by the view's toolCallId
// while the DO holds it open, else by the call's own output (it names the change request once settled); one that
// matches no reply goes with the newest reply. A card holds one reply's change requests of one tool and kind.

export interface ChangeRequestGroup {
  messageId: string;
  cardId: string;
  members: Schemas.WidgetChangeRequest[];
}

const KIND_KEY = (kind: Schemas.ChangeRequestKindEnum | null) => kind ?? "change";

export function groupChangeRequests(
  messages: UIMessage[],
  changeRequests: Record<string, Schemas.WidgetChangeRequest>,
): ChangeRequestGroup[] {
  const messageByToolCall = new Map<string, string>();
  const messageByChangeRequest = new Map<string, string>();
  const callOrder = new Map<string, number>();
  let lastAssistantId: string | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    lastAssistantId = message.id;
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      messageByToolCall.set(part.toolCallId, message.id);
      callOrder.set(part.toolCallId, callOrder.size);
      if (part.state !== "output-available") continue;
      const output = Schemas.ZHostToolOutput.safeParse(part.output);
      if (output.success && output.data.changeRequestId) {
        messageByChangeRequest.set(output.data.changeRequestId, message.id);
        callOrder.set(output.data.changeRequestId, callOrder.get(part.toolCallId) ?? 0);
      }
    }
  }

  const groups = new Map<string, ChangeRequestGroup>();
  for (const changeRequest of Object.values(changeRequests)) {
    const messageId =
      (changeRequest.toolCallId ? messageByToolCall.get(changeRequest.toolCallId) : undefined) ??
      messageByChangeRequest.get(changeRequest.publicId) ??
      lastAssistantId;
    if (!messageId) continue;
    const cardId = `${messageId}:${changeRequest.toolName}:${KIND_KEY(changeRequest.kind)}`;
    const group = groups.get(cardId) ?? { messageId, cardId, members: [] };
    group.members.push(changeRequest);
    groups.set(cardId, group);
  }
  const orderOf = (changeRequest: Schemas.WidgetChangeRequest) =>
    (changeRequest.toolCallId ? callOrder.get(changeRequest.toolCallId) : undefined) ??
    callOrder.get(changeRequest.publicId) ??
    Number.MAX_SAFE_INTEGER;
  for (const group of groups.values()) {
    group.members.sort((a, b) => orderOf(a) - orderOf(b));
  }
  return [...groups.values()];
}

const isProposed = (changeRequest: Schemas.WidgetChangeRequest) =>
  changeRequest.changeRequestStatus === Schemas.ChangeRequestStatusIntEnum.Proposed;

export function outcomeOf(
  status: Schemas.ChangeRequestStatusIntEnum,
): Schemas.WidgetChangeOutcomeEnum {
  switch (status) {
    case Schemas.ChangeRequestStatusIntEnum.Proposed:
      return Schemas.WidgetChangeOutcomeEnum.Waiting;
    case Schemas.ChangeRequestStatusIntEnum.Approved:
    case Schemas.ChangeRequestStatusIntEnum.Committing:
      return Schemas.WidgetChangeOutcomeEnum.Saving;
    case Schemas.ChangeRequestStatusIntEnum.Committed:
    case Schemas.ChangeRequestStatusIntEnum.Verified:
      return Schemas.WidgetChangeOutcomeEnum.Saved;
    case Schemas.ChangeRequestStatusIntEnum.Rejected:
    case Schemas.ChangeRequestStatusIntEnum.Undone:
      return Schemas.WidgetChangeOutcomeEnum.Rejected;
    case Schemas.ChangeRequestStatusIntEnum.Expired:
      return Schemas.WidgetChangeOutcomeEnum.Expired;
    case Schemas.ChangeRequestStatusIntEnum.Failed:
      return Schemas.WidgetChangeOutcomeEnum.Failed;
    case Schemas.ChangeRequestStatusIntEnum.Mismatch:
    case Schemas.ChangeRequestStatusIntEnum.NeedsHuman:
      return Schemas.WidgetChangeOutcomeEnum.NeedsPerson;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// DEV_NOTE: Day, short month, year (DESIGN.md: "22 Sep 2026"), assembled from parts: en-GB's short month is "Sept"
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const formatDate = (date: Date): string => {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    DATE_FORMAT.formatToParts(date).find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}`;
};

// DEV_NOTE: A host value as the card shows it: null = empty; a plain date (YYYY-MM-DD) as "22 Sep 2026"
export function displayValue(value: Schemas.ChangeRequestValue): string | null {
  if (!value.isFound || value.value === null) return null;
  const raw = value.value;
  if (typeof raw === "string") {
    if (ISO_DATE.test(raw)) {
      const date = new Date(`${raw}T00:00:00Z`);
      if (!Number.isNaN(date.getTime())) return formatDate(date);
    }
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return JSON.stringify(raw);
}

// DEV_NOTE: A value as the editor's input holds it (raw text; a date stays YYYY-MM-DD for the date input)
export function editText(value: Schemas.ChangeRequestValue | undefined): string {
  if (!value?.isFound || value.value === null) return "";
  return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
}

// DEV_NOTE: The editor's text back to the field's JSON value, or why it doesn't fit. The server checks it against the
// input_schema again; this only catches what the widget can tell (a number that isn't one, a value off the list).
export function parseEditText(
  field: Schemas.ChangeRequestEditableField,
  text: string,
): { isValid: true; value: Schemas.ChangeRequestEditValues[string] } | { isValid: false } {
  if (field.enumValues) {
    const match = field.enumValues.find((option) => String(option) === text);
    return match === undefined ? { isValid: false } : { isValid: true, value: match };
  }
  switch (field.type) {
    case Schemas.ChangeRequestFieldTypeEnum.String:
      return { isValid: true, value: text };
    case Schemas.ChangeRequestFieldTypeEnum.Boolean:
      return text === "true" || text === "false"
        ? { isValid: true, value: text === "true" }
        : { isValid: false };
    case Schemas.ChangeRequestFieldTypeEnum.Number:
    case Schemas.ChangeRequestFieldTypeEnum.Integer: {
      const trimmed = text.trim();
      const number = Number(trimmed);
      const isInteger = field.type === Schemas.ChangeRequestFieldTypeEnum.Integer;
      if (trimmed === "" || !Number.isFinite(number) || (isInteger && !Number.isInteger(number))) {
        return { isValid: false };
      }
      return { isValid: true, value: number };
    }
  }
}

// DEV_NOTE: The args that pick the record (unchanged, not editable): its id, as the card's mono label
function recordLabel(changeRequest: Schemas.WidgetChangeRequest): string | null {
  const editable = new Set(changeRequest.editableFields.map((field) => field.field));
  const picks = (changeRequest.changes ?? [])
    .filter((change) => !change.isChanged && !editable.has(change.field))
    .map((change) => displayValue(change.after))
    .filter((value): value is string => value !== null);
  return picks.length > 0 ? picks.join(" · ") : null;
}

function toRecord(
  changeRequest: Schemas.WidgetChangeRequest,
  review: Schemas.WidgetChangeReviewState,
  cardId: string,
): Schemas.WidgetChangeRecordView {
  const changes = changeRequest.changes ?? [];
  const draft = review.editing[cardId]?.[changeRequest.publicId] ?? {};
  const editableNames = new Set(changeRequest.editableFields.map((field) => field.field));
  const changed = changes.filter((change) => change.isChanged);
  const afterOf = (field: string) => changes.find((change) => change.field === field)?.after;
  return {
    changeRequestPublicId: changeRequest.publicId,
    label: recordLabel(changeRequest),
    lines: changed.map((change) => ({
      field: change.field,
      before: displayValue(change.before),
      after: displayValue(change.after),
      isChanged: true,
    })),
    editFields: [
      ...changeRequest.editableFields.map((field) => ({
        field: field.field,
        value: draft[field.field] ?? editText(afterOf(field.field)),
        editable: field,
      })),
      ...changed
        .filter((change) => !editableNames.has(change.field))
        .map((change) => ({
          field: change.field,
          value: displayValue(change.after) ?? "",
          editable: null,
        })),
    ],
    isIncluded: !review.excluded[changeRequest.publicId],
    isProposed: isProposed(changeRequest),
    wasEdited: changeRequest.wasEdited,
    outcome: outcomeOf(changeRequest.changeRequestStatus),
    status: changeRequest.changeRequestStatus,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const VERB: Record<Schemas.ChangeRequestKindEnum | "change", string> = {
  [Schemas.ChangeRequestKindEnum.Update]: "Update",
  [Schemas.ChangeRequestKindEnum.Create]: "Add",
  [Schemas.ChangeRequestKindEnum.Delete]: "Delete",
  change: "Change",
};

const OUTCOME_WORD: Record<Schemas.WidgetChangeOutcomeEnum, string> = {
  [Schemas.WidgetChangeOutcomeEnum.Waiting]: "waiting",
  [Schemas.WidgetChangeOutcomeEnum.Saving]: "saving",
  [Schemas.WidgetChangeOutcomeEnum.Saved]: "saved",
  [Schemas.WidgetChangeOutcomeEnum.Rejected]: "rejected",
  [Schemas.WidgetChangeOutcomeEnum.Expired]: "expired",
  [Schemas.WidgetChangeOutcomeEnum.Failed]: "not saved",
  [Schemas.WidgetChangeOutcomeEnum.NeedsPerson]: "needs a person",
};

function settledSummary(records: Schemas.WidgetChangeRecordView[]): string {
  const counts = new Map<Schemas.WidgetChangeOutcomeEnum, number>();
  for (const record of records) counts.set(record.outcome, (counts.get(record.outcome) ?? 0) + 1);
  const parts = [...counts.entries()].map(
    ([outcome, count]) => `${count} ${OUTCOME_WORD[outcome]}`,
  );
  const summary = parts.join(", ");
  return `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`;
}

export function toChangeCard(
  group: ChangeRequestGroup,
  review: Schemas.WidgetChangeReviewState,
): Schemas.WidgetChangeCardView {
  const [first] = group.members;
  const kind = first?.kind ?? null;
  const records = group.members.map((member) => toRecord(member, review, group.cardId));
  const proposed = records.filter((record) => record.isProposed);
  const included = proposed.filter((record) => record.isIncluded);
  const layout =
    records.length > Schemas.WIDGET_CHANGE_CARD_MAX_ROWS
      ? Schemas.WidgetChangeCardLayoutEnum.Bulk
      : Schemas.WidgetChangeCardLayoutEnum.Card;
  const stage =
    proposed.length === 0
      ? Schemas.WidgetChangeCardStageEnum.Settled
      : review.editing[group.cardId]
        ? Schemas.WidgetChangeCardStageEnum.Editing
        : Schemas.WidgetChangeCardStageEnum.Review;
  const verb = VERB[KIND_KEY(kind)];
  const unticked = proposed.length - included.length;

  const title =
    stage === Schemas.WidgetChangeCardStageEnum.Editing
      ? `Editing ${plural(records.length, "change")}`
      : layout === Schemas.WidgetChangeCardLayoutEnum.Bulk && unticked > 0
        ? `${verb} ${included.length} of ${plural(proposed.length, "record")}`
        : records.length === 1
          ? `${verb} a record`
          : `${verb} ${plural(records.length, "record")}`;

  const fields = new Set(records.flatMap((record) => record.lines.map((line) => line.field)));
  const subtitle =
    stage === Schemas.WidgetChangeCardStageEnum.Settled
      ? settledSummary(records)
      : stage === Schemas.WidgetChangeCardStageEnum.Editing
        ? "Your edits are checked again before anything is saved."
        : layout === Schemas.WidgetChangeCardLayoutEnum.Bulk
          ? [
              fields.size === 1 ? `${[...fields][0]} only.` : null,
              unticked > 0
                ? `You unticked ${plural(unticked, "record")}.`
                : "Untick any you want to keep as they are.",
            ]
              .filter(Boolean)
              .join(" ")
          : "Nothing is saved until you approve.";

  const expiries = proposed
    .map((record) => group.members.find((m) => m.publicId === record.changeRequestPublicId))
    .map((member) => member?.expiresAt ?? null)
    .filter((expiresAt): expiresAt is number => expiresAt !== null);
  const isCollapsed =
    layout === Schemas.WidgetChangeCardLayoutEnum.Bulk && !review.expanded[group.cardId];
  const shown = isCollapsed ? records.slice(0, Schemas.WIDGET_CHANGE_BULK_VISIBLE_ROWS) : records;

  return {
    id: group.cardId,
    toolName: first?.toolName ?? "",
    kind,
    layout,
    stage,
    isSending: proposed.length > 0 && review.sending[group.cardId] === true,
    title,
    subtitle,
    records: shown,
    hiddenCount: records.length - shown.length,
    includedCount: included.length,
    approveLabel: `Approve ${plural(included.length, "change")}`,
    canEdit:
      layout === Schemas.WidgetChangeCardLayoutEnum.Card &&
      proposed.some((record) => record.editFields.some((field) => field.editable !== null)),
    expiresAt: expiries.length > 0 ? Math.min(...expiries) : null,
    notice: review.notices[group.cardId] ?? null,
  };
}

// DEV_NOTE: Every reply's cards, by reply id
export function toChangeCardsByMessage(
  messages: UIMessage[],
  review: Schemas.WidgetChangeReviewState,
): Record<string, Schemas.WidgetChangeCardView[]> {
  const byMessage: Record<string, Schemas.WidgetChangeCardView[]> = {};
  for (const group of groupChangeRequests(messages, review.changeRequests)) {
    (byMessage[group.messageId] ??= []).push(toChangeCard(group, review));
  }
  return byMessage;
}

// DEV_NOTE: A write tool's step line (toolName isn't search_help_docs): what its output says happened, in the
// widget's words. Think's own paused output ({status: "paused"}) waits for the user.
export function hostToolStepLabel(part: Parameters<typeof getToolName>[0]): {
  label: string;
  isFailed: boolean;
} {
  if (part.state !== "output-available") return { label: "Working", isFailed: false };
  const output: unknown = part.output;
  if (
    typeof output === "object" &&
    output !== null &&
    "status" in output &&
    output.status === "paused"
  ) {
    return { label: "Waiting for your approval", isFailed: false };
  }
  const parsed = Schemas.ZHostToolOutput.safeParse(output);
  if (!parsed.success) return { label: "Done", isFailed: false };
  switch (parsed.data.status) {
    case Schemas.HostToolStatusEnum.Committed:
      return { label: "Change saved", isFailed: false };
    case Schemas.HostToolStatusEnum.Failed:
      return { label: "Change not saved", isFailed: true };
    case Schemas.HostToolStatusEnum.NeedsReview:
      return { label: "Sent to a person to check", isFailed: false };
    case Schemas.HostToolStatusEnum.NoChange:
      return { label: "Nothing to change", isFailed: false };
    case Schemas.HostToolStatusEnum.Error:
    case Schemas.HostToolStatusEnum.Blocked:
      return { label: "Step failed", isFailed: true };
    default:
      return { label: "Done", isFailed: false };
  }
}

import { useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";
import { useLatest } from "@/hooks/useLatest";
import { editText, groupChangeRequests, parseEditText } from "@/lib/changeRequestView";
import type { ChangeRequestGroup } from "@/lib/changeRequestView";
import { EMPTY_REVIEW } from "@/store/widgetStore";

// DEV_NOTE: The review cards' side of the chat socket (M3-5). The DO's change_request frames go into the store by
// public id (a frame with no toolCallId keeps the one an earlier frame had, so a settled card stays in its reply).
// Approve / Reject answer every Proposed change request of the card at once (one change_request_batch_decision frame:
// ticked → approve, unticked → reject), so the model replies once. Save edits sends the changed values only
// (change_request_edits); the card waits for every edit's answer and goes back to review with the re-checked diff
// once they all saved, else stays in the editor with the reason. Nothing here decides anything: the DO re-checks every
// answer and edit.
//
// Host token (minimal, M3-5): sent on every connect (getHostToken, never stored). When an answer or an edit gets
// token_needed, a fresh token is fetched and sent, and that frame is sent again once; a second token_needed, or no
// getHostToken, says to sign in again.
const SIGN_IN_NOTICE = "Sign in to the app again to approve changes. Nothing changed.";
const CHECK_VALUES_NOTICE = (fields: string[]) =>
  `Check ${fields.join(", ")}: the value doesn't fit. Nothing was sent.`;

// DEV_NOTE: Whether any edit of this card still waits for its answer
function hasPendingEdit(pendingEdits: Map<string, string>, cardId: string): boolean {
  for (const pendingCardId of pendingEdits.values()) {
    if (pendingCardId === cardId) return true;
  }
  return false;
}

interface SentReviewFrame {
  frame: string;
  cardId: string;
  isRetried: boolean;
}

export function useChangeReview(params: {
  storeApi: Schemas.WidgetStoreApi;
  messagesRef: RefObject<UIMessage[]>;
  send: (frame: string) => void;
  getHostToken: (() => Promise<string>) | null;
}) {
  const { storeApi, messagesRef, send } = params;
  const getHostTokenRef = useLatest(params.getHostToken);
  const lastFrameRef = useRef<SentReviewFrame | null>(null);
  // DEV_NOTE: The edits still waiting for their answer, by change request public id → card id
  const pendingEditsRef = useRef(new Map<string, string>());
  const editFailuresRef = useRef(new Map<string, string>());

  const patchReview = useCallback(
    (
      patch: (review: Schemas.WidgetChangeReviewState) => Partial<Schemas.WidgetChangeReviewState>,
    ) => {
      const review = storeApi.getState().review;
      storeApi.getState().patch({ review: { ...review, ...patch(review) } });
    },
    [storeApi],
  );

  const findGroup = useCallback(
    (cardId: string): ChangeRequestGroup | undefined =>
      groupChangeRequests(messagesRef.current, storeApi.getState().review.changeRequests).find(
        (group) => group.cardId === cardId,
      ),
    [messagesRef, storeApi],
  );

  const sendHostToken = useCallback(async (): Promise<boolean> => {
    const getHostToken = getHostTokenRef.current;
    if (!getHostToken) return false;
    try {
      const token = await getHostToken();
      send(JSON.stringify({ type: Schemas.WIDGET_HOST_TOKEN_FRAME_TYPE, token }));
      return true;
    } catch {
      return false;
    }
  }, [getHostTokenRef, send]);

  const sendReviewFrame = useCallback(
    (cardId: string, frame: string) => {
      lastFrameRef.current = { frame, cardId, isRetried: false };
      patchReview((review) => {
        const { [cardId]: _cleared, ...notices } = review.notices;
        return { sending: { ...review.sending, [cardId]: true }, notices };
      });
      send(frame);
    },
    [patchReview, send],
  );

  const stopSending = useCallback(
    (cardId: string | null, notice: string | null) => {
      patchReview((review) => {
        const sending = cardId ? { ...review.sending } : {};
        if (cardId) delete sending[cardId];
        const notices = cardId && notice ? { ...review.notices, [cardId]: notice } : review.notices;
        return { sending, notices };
      });
    },
    [patchReview],
  );

  const forgetEdits = useCallback((cardId: string) => {
    for (const [publicId, pendingCardId] of pendingEditsRef.current) {
      if (pendingCardId === cardId) pendingEditsRef.current.delete(publicId);
    }
    editFailuresRef.current.delete(cardId);
  }, []);

  // DEV_NOTE: One DO frame the review handles; false = not a review frame (useConversation handles it)
  const handleReviewFrame = useCallback(
    (frame: Schemas.WidgetServerMessage): boolean => {
      switch (frame.type) {
        case "change_request": {
          const { changeRequest } = frame;
          patchReview((review) => {
            const previous = review.changeRequests[changeRequest.publicId];
            const next = {
              ...changeRequest,
              toolCallId: changeRequest.toolCallId ?? previous?.toolCallId ?? null,
            };
            const sending = { ...review.sending };
            // DEV_NOTE: A card whose answers all landed (nothing Proposed any more) stops waiting
            const changeRequests = { ...review.changeRequests, [changeRequest.publicId]: next };
            for (const group of groupChangeRequests(messagesRef.current, changeRequests)) {
              const isWaiting = group.members.some(
                (member) =>
                  member.changeRequestStatus === Schemas.ChangeRequestStatusIntEnum.Proposed,
              );
              if (!isWaiting && !hasPendingEdit(pendingEditsRef.current, group.cardId))
                delete sending[group.cardId];
            }
            return { changeRequests, sending };
          });
          return true;
        }
        case "change_request_edit": {
          const cardId = pendingEditsRef.current.get(frame.changeRequestId);
          if (!cardId) return true;
          pendingEditsRef.current.delete(frame.changeRequestId);
          if (!frame.isSaved && frame.message) editFailuresRef.current.set(cardId, frame.message);
          if (hasPendingEdit(pendingEditsRef.current, cardId)) return true;
          const failure = editFailuresRef.current.get(cardId) ?? null;
          editFailuresRef.current.delete(cardId);
          lastFrameRef.current = null;
          patchReview((review) => {
            const { [cardId]: _sent, ...sending } = review.sending;
            if (failure) return { sending, notices: { ...review.notices, [cardId]: failure } };
            const { [cardId]: _edited, ...editing } = review.editing;
            return { sending, editing };
          });
          return true;
        }
        case "token_needed": {
          const last = lastFrameRef.current;
          if (!last || last.isRetried) {
            if (last) forgetEdits(last.cardId);
            lastFrameRef.current = null;
            stopSending(last?.cardId ?? null, SIGN_IN_NOTICE);
            return true;
          }
          lastFrameRef.current = { ...last, isRetried: true };
          void sendHostToken().then((isSent) => {
            if (isSent) {
              send(last.frame);
              return;
            }
            forgetEdits(last.cardId);
            lastFrameRef.current = null;
            stopSending(last.cardId, SIGN_IN_NOTICE);
          });
          return true;
        }
        case "error": {
          // DEV_NOTE: The DO refused the answer or edit (a reply still running, closing, not saved): every card can be
          // answered again; the message itself shows as the panel's notice
          const last = lastFrameRef.current;
          if (last) forgetEdits(last.cardId);
          lastFrameRef.current = null;
          stopSending(null, null);
          return false;
        }
        default:
          return false;
      }
    },
    [forgetEdits, messagesRef, patchReview, send, sendHostToken, stopSending],
  );

  const decide = useCallback(
    (cardId: string, isApprove: boolean) => {
      const group = findGroup(cardId);
      if (!group) return;
      const { excluded } = storeApi.getState().review;
      const decisions = group.members
        .filter(
          (member) => member.changeRequestStatus === Schemas.ChangeRequestStatusIntEnum.Proposed,
        )
        .map((member) => ({
          changeRequestId: member.publicId,
          decision:
            isApprove && !excluded[member.publicId]
              ? Schemas.ChangeRequestDecisionEnum.Approve
              : Schemas.ChangeRequestDecisionEnum.Reject,
        }));
      if (decisions.length === 0) return;
      sendReviewFrame(
        cardId,
        JSON.stringify({
          type: Schemas.WIDGET_CHANGE_REQUEST_BATCH_DECISION_FRAME_TYPE,
          decisions,
        }),
      );
    },
    [findGroup, sendReviewFrame, storeApi],
  );

  const saveEdits = useCallback(
    (cardId: string) => {
      const group = findGroup(cardId);
      const review = storeApi.getState().review;
      const drafts = review.editing[cardId];
      if (!group || !drafts) return;
      const invalid: string[] = [];
      const edits: { changeRequestId: string; values: Schemas.ChangeRequestEditValues }[] = [];
      for (const member of group.members) {
        if (member.changeRequestStatus !== Schemas.ChangeRequestStatusIntEnum.Proposed) continue;
        if (review.excluded[member.publicId]) continue;
        const draft = drafts[member.publicId] ?? {};
        const values: Schemas.ChangeRequestEditValues = {};
        for (const field of member.editableFields) {
          const text = draft[field.field];
          if (text === undefined) continue;
          const current = member.changes?.find((change) => change.field === field.field)?.after;
          if (text === editText(current)) continue;
          const parsed = parseEditText(field, text);
          if (!parsed.isValid) {
            invalid.push(field.field);
            continue;
          }
          values[field.field] = parsed.value;
        }
        if (Object.keys(values).length > 0)
          edits.push({ changeRequestId: member.publicId, values });
      }
      if (invalid.length > 0) {
        patchReview((current) => ({
          notices: { ...current.notices, [cardId]: CHECK_VALUES_NOTICE([...new Set(invalid)]) },
        }));
        return;
      }
      // DEV_NOTE: Nothing changed: back to the card as it was
      if (edits.length === 0) {
        patchReview((current) => {
          const { [cardId]: _edited, ...editing } = current.editing;
          return { editing };
        });
        return;
      }
      editFailuresRef.current.delete(cardId);
      for (const edit of edits) pendingEditsRef.current.set(edit.changeRequestId, cardId);
      sendReviewFrame(
        cardId,
        JSON.stringify({ type: Schemas.WIDGET_CHANGE_REQUEST_EDITS_FRAME_TYPE, edits }),
      );
    },
    [findGroup, patchReview, sendReviewFrame, storeApi],
  );

  const actions: Schemas.WidgetChangeCardActions = useMemo(
    () => ({
      onApprove: (cardId) => decide(cardId, true),
      onReject: (cardId) => decide(cardId, false),
      onEdit: (cardId) =>
        patchReview((review) => {
          const { [cardId]: _cleared, ...notices } = review.notices;
          return { editing: { ...review.editing, [cardId]: {} }, notices };
        }),
      onCancelEdit: (cardId) =>
        patchReview((review) => {
          const { [cardId]: _edited, ...editing } = review.editing;
          const { [cardId]: _cleared, ...notices } = review.notices;
          // DEV_NOTE: Records removed in the editor come back
          const group = findGroup(cardId);
          const excluded = { ...review.excluded };
          for (const member of group?.members ?? []) delete excluded[member.publicId];
          return { editing, notices, excluded };
        }),
      onSaveEdits: saveEdits,
      onEditValue: (cardId, changeRequestPublicId, field, value) =>
        patchReview((review) => {
          const card = review.editing[cardId] ?? {};
          const record = card[changeRequestPublicId] ?? {};
          return {
            editing: {
              ...review.editing,
              [cardId]: { ...card, [changeRequestPublicId]: { ...record, [field]: value } },
            },
          };
        }),
      onToggleRecord: (_cardId, changeRequestPublicId) =>
        patchReview((review) => {
          const excluded = { ...review.excluded };
          if (excluded[changeRequestPublicId]) {
            delete excluded[changeRequestPublicId];
          } else {
            excluded[changeRequestPublicId] = true;
          }
          return { excluded };
        }),
      onShowMore: (cardId) =>
        patchReview((review) => ({ expanded: { ...review.expanded, [cardId]: true } })),
    }),
    [decide, findGroup, patchReview, saveEdits],
  );

  // DEV_NOTE: A conversation that ends takes its review with it
  const resetReview = useCallback(() => {
    pendingEditsRef.current.clear();
    editFailuresRef.current.clear();
    lastFrameRef.current = null;
    storeApi.getState().patch({ review: EMPTY_REVIEW });
  }, [storeApi]);

  return { handleReviewFrame, actions, sendHostToken, resetReview };
}

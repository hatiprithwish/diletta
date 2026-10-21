import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import Utility from "@/utils/Utility";

// DEV_NOTE: The Conversation DO's inbound frame allowlist (pattern rule 3.23), pure so it is unit-tested on its own.
// Think would otherwise let a client clear or rewrite the transcript, push tools or set state. Admitted:
//   - a chat request, rebuilt to carry only its newest message: a user text message with a new id (Think overwrites
//     the stored message of an id it already has), ≤ WIDGET_MESSAGE_MAX_CHARS, and nothing else from the body (no
//     client history, client tools, custom fields or regeneration);
//   - cancel and stream-resume frames, unchanged;
//   - the widget's own feedback frame (M2-7): a rating for one reply, which the DO stores itself (Think never sees it);
//   - the widget's host_token frame (M3-4): the user's host bearer token for the DO's memory (the reason a malformed
//     one is refused never holds it);
//   - the widget's change_request_decision frame (M3-4): approve or reject one proposal, handled by the DO itself.
// Everything else is refused with a reason for the log; the widget only learns the frame was refused. Think's own tool
// approval frames stay refused: an approval goes through the DO's decision path only.
export default class WidgetFrameProvider {
  static admit(
    message: string | ArrayBuffer,
    existingMessageIds: ReadonlySet<string>,
  ): Schemas.WidgetFrameAdmission {
    if (typeof message !== "string") {
      return { kind: "refuse", reason: "Binary frame" };
    }
    if (message.length > Constants.WIDGET_FRAME_MAX_BYTES) {
      return { kind: "refuse", reason: "Frame too large" };
    }

    const json = Utility.parseJson(message);
    const envelope = Schemas.ZWidgetFrameEnvelope.safeParse(json);
    if (!envelope.success) {
      return { kind: "refuse", reason: "Not a JSON frame with a type" };
    }

    if (envelope.data.type === Schemas.WidgetChatFrameTypeEnum.ChatRequest) {
      return WidgetFrameProvider.admitChatRequest(json, existingMessageIds);
    }
    if (envelope.data.type === Schemas.WIDGET_FEEDBACK_FRAME_TYPE) {
      const feedback = Schemas.ZWidgetFeedbackFrame.safeParse(json);
      return feedback.success
        ? { kind: "feedback", messageId: feedback.data.messageId, rating: feedback.data.rating }
        : { kind: "refuse", reason: "Malformed feedback" };
    }
    if (envelope.data.type === Schemas.WIDGET_HOST_TOKEN_FRAME_TYPE) {
      const hostToken = Schemas.ZWidgetHostTokenFrame.safeParse(json);
      return hostToken.success
        ? { kind: "hostToken", token: hostToken.data.token }
        : { kind: "refuse", reason: "Malformed host token" };
    }
    if (envelope.data.type === Schemas.WIDGET_CHANGE_REQUEST_DECISION_FRAME_TYPE) {
      const decision = Schemas.ZWidgetChangeRequestDecisionFrame.safeParse(json);
      return decision.success
        ? {
            kind: "decision",
            changeRequestPublicId: decision.data.changeRequestId,
            decision: decision.data.decision,
          }
        : { kind: "refuse", reason: "Malformed change request decision" };
    }
    if (Schemas.ZWidgetPassThroughFrame.safeParse(json).success) {
      return { kind: "pass", frame: message };
    }
    return { kind: "refuse", reason: `Frame type not allowed: ${envelope.data.type.slice(0, 64)}` };
  }

  private static admitChatRequest(
    json: unknown,
    existingMessageIds: ReadonlySet<string>,
  ): Schemas.WidgetFrameAdmission {
    const frame = Schemas.ZWidgetChatRequestFrame.safeParse(json);
    if (!frame.success) {
      return { kind: "refuse", reason: "Malformed chat request" };
    }
    const body = Schemas.ZWidgetChatRequestBody.safeParse(Utility.parseJson(frame.data.init.body));
    if (!body.success) {
      return { kind: "refuse", reason: "Malformed chat request body" };
    }
    const newest = Schemas.ZWidgetUserMessage.safeParse(
      body.data.messages[body.data.messages.length - 1],
    );
    if (!newest.success) {
      return { kind: "refuse", reason: "Newest message is not a user text message" };
    }

    const text = newest.data.parts
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length === 0 || text.length > Schemas.WIDGET_MESSAGE_MAX_CHARS) {
      return { kind: "refuse", reason: "Message empty or too long" };
    }
    if (existingMessageIds.has(newest.data.id)) {
      return { kind: "refuse", reason: "Message id already in the transcript" };
    }

    const message = { id: newest.data.id, text };
    return {
      kind: "chat",
      requestId: frame.data.id,
      message,
      frame: JSON.stringify({
        type: Schemas.WidgetChatFrameTypeEnum.ChatRequest,
        id: frame.data.id,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages: [{ id: message.id, role: "user", parts: [{ type: "text", text }] }],
          }),
        },
      }),
    };
  }
}

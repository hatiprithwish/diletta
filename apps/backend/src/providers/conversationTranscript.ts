import ActivityRollupsProvider from "@/providers/activityRollups";
import * as Schemas from "@app/schemas";

const COST_SCALE = 6;

interface TurnParts {
  turnId: string;
  firstAt: number;
  userMessages: Schemas.ConversationTurnMessage[];
  toolCalls: Schemas.ConversationTurnToolCall[];
  replies: Schemas.ConversationTurnMessage[];
  costUnits: bigint;
  pendingCount: number;
  unknownCount: number;
}

// DEV_NOTE: The dashboard transcript (M4-4), pure. A turn is one turn_id: the user message and its replies share it
// (a continuation after an approval reuses it), and its tool calls and model calls carry it. Turns are every turn id
// found in the messages, tool calls and spend model calls, ordered by the earliest row of each (then by id, a ULID), and
// numbered from 1. Inside a turn: the user's message, then the tool calls, then the replies. A turn's cost is the exact
// sum of its spend model calls (bigint micro-dollars, never floats); the conversation's adds the calls with no turn.
// Never reads args or values: tool calls arrive without them.
export default class ConversationTranscriptProvider {
  static buildTranscript(params: {
    messages: Schemas.TranscriptMessageRow[];
    toolCalls: Schemas.TranscriptToolCallRow[];
    turnCosts: Schemas.ConversationTurnCostRow[];
  }): Pick<Schemas.ConversationDetail, "turns" | "costUsd" | "costNote"> {
    const turns = new Map<string, TurnParts>();
    const turnOf = (turnId: string, at: Date): TurnParts => {
      let turn = turns.get(turnId);
      if (!turn) {
        turn = {
          turnId,
          firstAt: at.getTime(),
          userMessages: [],
          toolCalls: [],
          replies: [],
          costUnits: 0n,
          pendingCount: 0,
          unknownCount: 0,
        };
        turns.set(turnId, turn);
      }
      turn.firstAt = Math.min(turn.firstAt, at.getTime());
      return turn;
    };

    for (const message of params.messages) {
      const turn = turnOf(message.turnId, message.createdAt);
      const entry = ConversationTranscriptProvider.toMessageEntry(message);
      if (message.role === Schemas.MessageRoleIntEnum.User) {
        turn.userMessages.push(entry);
      } else {
        turn.replies.push(entry);
      }
    }
    for (const toolCall of params.toolCalls) {
      turnOf(toolCall.turnId, toolCall.createdAt).toolCalls.push(
        ConversationTranscriptProvider.toToolEntry(toolCall),
      );
    }

    let totalUnits = 0n;
    let totalPending = 0;
    let totalUnknown = 0;
    for (const cost of params.turnCosts) {
      const units = ActivityRollupsProvider.toUnits(cost.costUsd, COST_SCALE);
      totalUnits += units;
      totalPending += cost.pendingCount;
      totalUnknown += cost.unknownCount;
      if (cost.turnId === null) continue;
      const turn = turnOf(cost.turnId, cost.firstAt);
      turn.costUnits += units;
      turn.pendingCount += cost.pendingCount;
      turn.unknownCount += cost.unknownCount;
    }

    const ordered = [...turns.values()].sort((a, b) =>
      a.firstAt !== b.firstAt ? a.firstAt - b.firstAt : a.turnId < b.turnId ? -1 : 1,
    );
    return {
      turns: ordered.map((turn, index) => ({
        number: index + 1,
        startedAt: new Date(turn.firstAt).toISOString(),
        costUsd: ActivityRollupsProvider.fromUnits(turn.costUnits, COST_SCALE),
        costNote: ConversationTranscriptProvider.costNote(turn.pendingCount, turn.unknownCount),
        entries: [...turn.userMessages, ...turn.toolCalls, ...turn.replies],
      })),
      costUsd: ActivityRollupsProvider.fromUnits(totalUnits, COST_SCALE),
      costNote: ConversationTranscriptProvider.costNote(totalPending, totalUnknown),
    };
  }

  // DEV_NOTE: Unknown wins: its cost is 0 for good, while a Pending one is still coming in
  static costNote(
    pendingCount: number,
    unknownCount: number,
  ): Schemas.ConversationCostNoteEnum | null {
    if (unknownCount > 0) return Schemas.ConversationCostNoteEnum.Unknown;
    if (pendingCount > 0) return Schemas.ConversationCostNoteEnum.Pending;
    return null;
  }

  // DEV_NOTE: content is jsonb (read untyped) and null once purged: anything that doesn't parse shows as no text
  private static toMessageEntry(
    message: Schemas.TranscriptMessageRow,
  ): Schemas.ConversationTurnMessage {
    const content = Schemas.ZMessageContent.safeParse(message.content);
    return {
      kind: Schemas.ConversationTurnEntryKindEnum.Message,
      publicId: message.publicId,
      role: message.role,
      roleLabel: Schemas.MESSAGE_ROLE_LABEL_MAP[message.role],
      text: content.success ? content.data.text : null,
      citations: content.success
        ? (content.data.citations ?? []).map(({ n, title, sourceUrl }) => ({ n, title, sourceUrl }))
        : [],
      rating: message.rating,
      ratingLabel:
        message.rating === null ? null : Schemas.FEEDBACK_RATING_LABEL_MAP[message.rating],
    };
  }

  // DEV_NOTE: An error code the enums no longer know keeps its code and reads as a server error
  private static toToolEntry(
    toolCall: Schemas.TranscriptToolCallRow,
  ): Schemas.ConversationTurnToolCall {
    const toolError =
      toolCall.errorCode === null ? null : Schemas.ZToolCallErrorCode.safeParse(toolCall.errorCode);
    const toolErrorCode = toolError?.success
      ? toolError.data
      : toolError
        ? Schemas.ToolCallErrorCodeEnum.ServerError
        : null;
    const { change } = toolCall;
    return {
      kind: Schemas.ConversationTurnEntryKindEnum.Tool,
      publicId: toolCall.publicId,
      toolName: toolCall.toolName,
      toolVersion: toolCall.toolVersion,
      toolCallStatus: toolCall.status,
      toolCallStatusLabel: Schemas.TOOL_CALL_STATUS_LABEL_MAP[toolCall.status],
      errorCode: toolErrorCode,
      errorLabel: toolErrorCode === null ? null : Schemas.TOOL_CALL_ERROR_LABEL_MAP[toolErrorCode],
      change: change
        ? {
            publicId: change.publicId,
            summary: change.summary,
            changeCount: change.changeCount,
            changeRequestStatus: change.status,
            changeRequestStatusLabel: Schemas.CHANGE_REQUEST_STATUS_LABEL_MAP[change.status],
            errorCode: change.errorCode,
            errorLabel:
              change.errorCode === null
                ? null
                : Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP[change.errorCode],
          }
        : null,
    };
  }
}

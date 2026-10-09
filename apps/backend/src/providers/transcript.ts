import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Maps the Conversation DO's Think transcript (the source of truth) onto the messages read model. Pure, so
// it is unit-tested on its own. The DO keeps how many transcript messages are already in messages
// (syncedMessageCount) and re-syncs from there after every turn and on every wake: a failed write, or a turn cut by
// an eviction (every deploy), is caught up on later instead of being lost. Writes are idempotent per Think message id.
export default class TranscriptProvider {
  static toEntries(messages: UIMessage[]): Schemas.TranscriptEntry[] {
    return messages.map((message) => ({
      id: message.id,
      role: message.role === "user" || message.role === "assistant" ? message.role : "other",
      text: message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim(),
    }));
  }

  // DEV_NOTE: The transcript after syncedCount, cut into turns: each user message starts one, and the replies after it
  // belong to it. A turn takes the ULID its user message was admitted under (turnIds), or a new one when that was
  // lost. Replies with no user message ahead of them in the slice (a reply that landed after its user message was
  // synced) go under lastSyncedTurnId. Entries with no text (tool or system parts) aren't written but are counted.
  static unsyncedTurns(params: {
    entries: Schemas.TranscriptEntry[];
    syncedCount: number;
    turnIds: Record<string, string>;
    lastSyncedTurnId: string | null;
    mintTurnId: () => string;
    titleMaxChars: number;
  }): Schemas.TranscriptTurn[] {
    const turns: Schemas.TranscriptTurn[] = [];
    let current: Schemas.TranscriptTurn | null = null;

    for (const entry of params.entries.slice(params.syncedCount)) {
      if (entry.role === "user") {
        current = {
          turnId: params.turnIds[entry.id] ?? params.mintTurnId(),
          userMessageId: entry.id,
          messages: [],
          title: entry.text.slice(0, params.titleMaxChars) || null,
          entryCount: 0,
        };
        turns.push(current);
      } else if (!current) {
        current = {
          turnId: params.lastSyncedTurnId ?? params.mintTurnId(),
          userMessageId: null,
          messages: [],
          title: null,
          entryCount: 0,
        };
        turns.push(current);
      }

      current.entryCount += 1;
      if (entry.role !== "other" && entry.text.length > 0) {
        current.messages.push({
          sessionMessageId: entry.id,
          role:
            entry.role === "user"
              ? Schemas.MessageRoleIntEnum.User
              : Schemas.MessageRoleIntEnum.Assistant,
          content: { text: entry.text },
        });
      }
    }

    return turns;
  }
}

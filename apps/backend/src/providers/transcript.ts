import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";
import SearchHelpDocsProvider from "@/providers/searchHelpDocs";

const SEARCH_TOOL_PART_TYPE = `tool-${Schemas.SEARCH_HELP_DOCS_TOOL_NAME}`;

// DEV_NOTE: Maps the Conversation DO's Think transcript (the source of truth) onto the messages read model. Pure, so
// it is unit-tested on its own. The DO keeps the id of the last message already in messages (lastSyncedMessageId) and
// re-syncs from there after every turn and on every wake: a failed write, or a turn cut by an eviction (every deploy),
// is caught up on later instead of being lost. Writes are idempotent per Think message id.
//
// Citations (M2-6): a reply's search_help_docs citations sit in its own message, as tool parts before its text. Each
// written reply keeps the ones its [n] markers cite (SearchHelpDocsProvider.citedBy), looked up in every search of
// its turn so far; a reply that cites none is written with its text only.
export default class TranscriptProvider {
  static toEntries(messages: UIMessage[]): Schemas.TranscriptEntry[] {
    return messages.map((message) => ({
      id: message.id,
      role: message.role === "user" || message.role === "assistant" ? message.role : "other",
      text: message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim(),
      searchCitations: message.parts.flatMap((part) => TranscriptProvider.searchCitationsOf(part)),
    }));
  }

  // DEV_NOTE: The citations of one finished search_help_docs call (its output never carries excerpt text); anything
  // else (another part, a call still running or failed, an output of the wrong shape) has none
  private static searchCitationsOf(part: UIMessage["parts"][number]): Schemas.KnowledgeCitation[] {
    const isSearch =
      part.type === SEARCH_TOOL_PART_TYPE ||
      (part.type === "dynamic-tool" && part.toolName === Schemas.SEARCH_HELP_DOCS_TOOL_NAME);
    if (!isSearch || !("state" in part) || part.state !== "output-available") return [];
    const parsed = Schemas.ZSearchHelpDocsOutput.safeParse(part.output);
    return parsed.success ? parsed.data.results : [];
  }

  // DEV_NOTE: The transcript after the last synced message, cut into turns: each user message starts one, and the
  // replies after it belong to it. A turn takes the ULID its user message was admitted under (turnIds), or a new one
  // when that was lost. Replies with no user message ahead of them in the slice (a reply that landed after its user
  // message was synced) go under lastSyncedTurnId. Entries with no text (tool or system parts) aren't written but move
  // the position. The position is a message id, not an index: when Think loaded a view without it (empty, or a recent
  // window), isPositionLost and nothing is returned rather than skip or repeat messages.
  static unsyncedTurns(params: {
    entries: Schemas.TranscriptEntry[];
    lastSyncedMessageId: string | null;
    turnIds: Record<string, string>;
    lastSyncedTurnId: string | null;
    mintTurnId: () => string;
    titleMaxChars: number;
  }): Schemas.UnsyncedTranscript {
    let start = 0;
    if (params.lastSyncedMessageId !== null) {
      const index = params.entries.findIndex((entry) => entry.id === params.lastSyncedMessageId);
      if (index < 0) {
        return { turns: [], isPositionLost: true };
      }
      start = index + 1;
    }

    const turns: Schemas.TranscriptTurn[] = [];
    let current: Schemas.TranscriptTurn | null = null;
    let turnSearchCitations: Schemas.KnowledgeCitation[] = [];
    for (const entry of params.entries.slice(start)) {
      if (entry.role === "user" || !current) {
        const isUser = entry.role === "user";
        current = {
          turnId: isUser
            ? (params.turnIds[entry.id] ?? params.mintTurnId())
            : (params.lastSyncedTurnId ?? params.mintTurnId()),
          userMessageId: isUser ? entry.id : null,
          messages: [],
          title: isUser ? entry.text.slice(0, params.titleMaxChars) || null : null,
          lastEntryId: entry.id,
        };
        turns.push(current);
        turnSearchCitations = [];
      }

      current.lastEntryId = entry.id;
      turnSearchCitations = [...turnSearchCitations, ...entry.searchCitations];
      if (entry.role !== "other" && entry.text.length > 0) {
        const citations =
          entry.role === "assistant"
            ? SearchHelpDocsProvider.citedBy(entry.text, turnSearchCitations)
            : [];
        current.messages.push({
          sessionMessageId: entry.id,
          role:
            entry.role === "user"
              ? Schemas.MessageRoleIntEnum.User
              : Schemas.MessageRoleIntEnum.Assistant,
          content: citations.length > 0 ? { text: entry.text, citations } : { text: entry.text },
        });
      }
    }

    return { turns, isPositionLost: false };
  }
}

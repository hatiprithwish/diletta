import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";

const SEARCH_TOOL_PART_TYPE = `tool-${Schemas.SEARCH_HELP_DOCS_TOOL_NAME}`;

// DEV_NOTE: Maps the Conversation DO's Think transcript (the source of truth) onto the messages read model. Pure, so
// it is unit-tested on its own. The DO keeps the id of the last message already in messages (lastSyncedMessageId) and
// re-syncs from there after every turn and on every wake: a failed write, or a turn cut by an eviction (every deploy),
// is caught up on later instead of being lost. Writes are idempotent per Think message id.
//
// Citations (M2-6): a reply's search_help_docs citations sit in its own message, as tool parts before its text. Each
// written reply keeps the ones its [n] markers cite (Schemas.citedBy), looked up in every search of
// its turn so far; a reply that cites none is written with its text only. Such a turn after a search is what doc gaps
// start from (M5-6, docGapSignal).
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
      searchStatuses: message.parts.flatMap((part) => TranscriptProvider.searchStatusOf(part)),
      hasUnfinishedTool: message.parts.some((part) => TranscriptProvider.isUnfinishedTool(part)),
    }));
  }

  // DEV_NOTE: The citations of one finished search_help_docs call (its output never carries excerpt text); anything
  // else (another part, a call still running or failed, an output of the wrong shape) has none
  private static searchCitationsOf(part: UIMessage["parts"][number]): Schemas.KnowledgeCitation[] {
    return TranscriptProvider.searchOutputOf(part)?.results ?? [];
  }

  // DEV_NOTE: How a finished search_help_docs call came out (M5-6); its citations alone can't tell an empty search
  // from no search
  private static searchStatusOf(
    part: UIMessage["parts"][number],
  ): Schemas.SearchHelpDocsStatusEnum[] {
    const output = TranscriptProvider.searchOutputOf(part);
    return output ? [output.status] : [];
  }

  // DEV_NOTE: A tool call with no result yet: running, or paused for an approval (M3-4)
  private static isUnfinishedTool(part: UIMessage["parts"][number]): boolean {
    if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") return false;
    return !(
      "state" in part &&
      (part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied")
    );
  }

  private static searchOutputOf(
    part: UIMessage["parts"][number],
  ): Schemas.SearchHelpDocsOutput | null {
    const isSearch =
      part.type === SEARCH_TOOL_PART_TYPE ||
      (part.type === "dynamic-tool" && part.toolName === Schemas.SEARCH_HELP_DOCS_TOOL_NAME);
    if (!isSearch || !("state" in part) || part.state !== "output-available") return null;
    const parsed = Schemas.ZSearchHelpDocsOutput.safeParse(part.output);
    return parsed.success ? parsed.data : null;
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
    let turnSearchStatuses: Schemas.SearchHelpDocsStatusEnum[] = [];
    let turnHasCitations = false;
    let turnHasReply = false;
    let turnHasUnfinishedTool = false;
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
          docGapSignal: null,
        };
        turns.push(current);
        turnSearchCitations = [];
        turnSearchStatuses = [];
        turnHasCitations = false;
        turnHasReply = false;
        turnHasUnfinishedTool = false;
      }

      current.lastEntryId = entry.id;
      turnSearchCitations = [...turnSearchCitations, ...entry.searchCitations];
      turnSearchStatuses = [...turnSearchStatuses, ...entry.searchStatuses];
      turnHasUnfinishedTool ||= entry.hasUnfinishedTool;
      if (entry.role !== "other" && entry.text.length > 0) {
        const citations =
          entry.role === "assistant" ? Schemas.citedBy(entry.text, turnSearchCitations) : [];
        current.messages.push({
          sessionMessageId: entry.id,
          role:
            entry.role === "user"
              ? Schemas.MessageRoleIntEnum.User
              : Schemas.MessageRoleIntEnum.Assistant,
          content: citations.length > 0 ? { text: entry.text, citations } : { text: entry.text },
        });
        if (entry.role === "assistant") {
          turnHasReply = true;
          turnHasCitations ||= citations.length > 0;
        }
      }
      // DEV_NOTE: Doc gaps (M5-6): only a turn with its user message in this slice can be a candidate
      if (current.userMessageId !== null) {
        current.docGapSignal = Schemas.docGapCandidateSignal({
          searchStatuses: turnSearchStatuses,
          hasReply: turnHasReply,
          hasCitations: turnHasCitations,
          hasUnfinishedTool: turnHasUnfinishedTool,
        });
      }
    }

    return { turns, isPositionLost: false };
  }
}

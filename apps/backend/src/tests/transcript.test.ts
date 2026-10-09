import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import TranscriptProvider from "@/providers/transcript";

// DEV_NOTE: Unit tests for how the Think transcript maps onto the messages read model: no DO, no database

const user = (id: string, text: string) => ({
  id,
  role: "user" as const,
  text,
  searchResults: [],
});
const assistant = (
  id: string,
  text: string,
  searchResults: Schemas.SearchHelpDocsResult[] = [],
) => ({ id, role: "assistant" as const, text, searchResults });

const result = (n: number, documentPublicId: string): Schemas.SearchHelpDocsResult => ({
  n,
  documentPublicId,
  title: `Doc ${documentPublicId}`,
  sourceUrl: `https://docs.example.com/${documentPublicId}`,
  headingPath: null,
  text: `Excerpt ${n}`,
});
const citation = (n: number, documentPublicId: string): Schemas.KnowledgeCitation => ({
  n,
  documentPublicId,
  title: `Doc ${documentPublicId}`,
  sourceUrl: `https://docs.example.com/${documentPublicId}`,
});

function unsynced(
  entries: ReturnType<typeof TranscriptProvider.toEntries>,
  options: {
    lastSyncedMessageId?: string | null;
    turnIds?: Record<string, string>;
    lastSyncedTurnId?: string | null;
  } = {},
) {
  let minted = 0;
  return TranscriptProvider.unsyncedTurns({
    entries,
    lastSyncedMessageId: options.lastSyncedMessageId ?? null,
    turnIds: options.turnIds ?? {},
    lastSyncedTurnId: options.lastSyncedTurnId ?? null,
    mintTurnId: () => `minted-${++minted}`,
    titleMaxChars: 10,
  });
}

const userRow = (id: string, text: string) => ({
  sessionMessageId: id,
  role: Schemas.MessageRoleIntEnum.User,
  content: { text },
});
const assistantRow = (id: string, text: string) => ({
  sessionMessageId: id,
  role: Schemas.MessageRoleIntEnum.Assistant,
  content: { text },
});

describe("TranscriptProvider.toEntries", () => {
  it("keeps id, role and text, and marks other roles", () => {
    expect(
      TranscriptProvider.toEntries([
        { id: "u", role: "user", parts: [{ type: "text", text: " Hi " }] },
        {
          id: "a",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "Hello" },
            { type: "text", text: " there" },
          ],
        },
        { id: "s", role: "system", parts: [{ type: "text", text: "sys" }] },
      ]),
    ).toEqual([
      { id: "u", role: "user", text: "Hi", searchResults: [] },
      { id: "a", role: "assistant", text: "Hello there", searchResults: [] },
      { id: "s", role: "other", text: "sys", searchResults: [] },
    ]);
  });

  it("reads the results of finished search_help_docs calls only", () => {
    const output: Schemas.SearchHelpDocsOutput = {
      status: Schemas.SearchHelpDocsStatusEnum.Found,
      results: [result(1, "kd_a")],
    };
    const [entry] = TranscriptProvider.toEntries([
      {
        id: "a",
        role: "assistant",
        parts: [
          {
            type: `tool-${Schemas.SEARCH_HELP_DOCS_TOOL_NAME}`,
            toolCallId: "call-1",
            state: "output-available",
            input: { query: "refunds" },
            output,
          },
          {
            type: `tool-${Schemas.SEARCH_HELP_DOCS_TOOL_NAME}`,
            toolCallId: "call-2",
            state: "input-available",
            input: { query: "still running" },
          },
          {
            type: `tool-${Schemas.SEARCH_HELP_DOCS_TOOL_NAME}`,
            toolCallId: "call-3",
            state: "output-available",
            input: { query: "bad shape" },
            output: { results: "not a list" },
          },
          {
            type: "tool-other_tool",
            toolCallId: "call-4",
            state: "output-available",
            input: {},
            output,
          },
          { type: "text", text: "Refunds take 5 days [1]." },
        ],
      },
    ]);
    expect(entry?.searchResults).toEqual([result(1, "kd_a")]);
    expect(entry?.text).toBe("Refunds take 5 days [1].");
  });
});

describe("TranscriptProvider.unsyncedTurns", () => {
  it("groups each user message with its replies, under the turn id it was admitted with", () => {
    const result = unsynced(
      [
        user("u1", "First question"),
        assistant("a1", "One"),
        user("u2", "Second"),
        assistant("a2", "Two"),
      ],
      { turnIds: { u1: "turn-1", u2: "turn-2" } },
    );
    expect(result).toEqual({
      isPositionLost: false,
      turns: [
        {
          turnId: "turn-1",
          userMessageId: "u1",
          title: "First ques",
          lastEntryId: "a1",
          messages: [userRow("u1", "First question"), assistantRow("a1", "One")],
        },
        {
          turnId: "turn-2",
          userMessageId: "u2",
          title: "Second",
          lastEntryId: "a2",
          messages: [userRow("u2", "Second"), assistantRow("a2", "Two")],
        },
      ],
    });
  });

  it("starts after the last synced message, and mints a turn id that was lost", () => {
    const result = unsynced(
      [user("u1", "Old"), assistant("a1", "Old reply"), user("u2", "Cut by an eviction")],
      { lastSyncedMessageId: "a1" },
    );
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({
      turnId: "minted-1",
      userMessageId: "u2",
      lastEntryId: "u2",
    });
  });

  it("defers when the last synced message isn't in the loaded transcript, instead of skipping or repeating", () => {
    expect(unsynced([], { lastSyncedMessageId: "a1" })).toEqual({
      turns: [],
      isPositionLost: true,
    });
    expect(unsynced([user("u9", "A recent window only")], { lastSyncedMessageId: "a1" })).toEqual({
      turns: [],
      isPositionLost: true,
    });
  });

  it("puts a reply that landed after its user message was synced under the last synced turn", () => {
    const result = unsynced([user("u1", "Q"), assistant("a1", "Late reply")], {
      lastSyncedMessageId: "u1",
      lastSyncedTurnId: "turn-1",
    });
    expect(result.turns).toEqual([
      {
        turnId: "turn-1",
        userMessageId: null,
        title: null,
        lastEntryId: "a1",
        messages: [assistantRow("a1", "Late reply")],
      },
    ]);
  });

  it("moves past entries with no text or another role without writing them", () => {
    const result = unsynced([
      user("u1", "Q"),
      assistant("a1", ""),
      { id: "s1", role: "other", text: "sys", searchResults: [] },
    ]);
    expect(result.turns[0]?.lastEntryId).toBe("s1");
    expect(result.turns[0]?.messages.map((message) => message.sessionMessageId)).toEqual(["u1"]);
  });

  it("keeps the citations a reply's markers point at, from any search of its turn", () => {
    const synced = unsynced(
      [
        user("u1", "Refunds?"),
        assistant("a1", "Searching", [result(1, "kd_a"), result(2, "kd_b")]),
        assistant("a2", "Refunds take 5 days [2], see also [1, 2] and [7].", [result(3, "kd_c")]),
        user("u2", "And returns [1]?"),
        assistant("a3", "Returns are free [1]."),
      ],
      { turnIds: { u1: "turn-1", u2: "turn-2" } },
    );
    const [first, second] = synced.turns;
    expect(first?.messages[1]?.content).toEqual({ text: "Searching" });
    expect(first?.messages[2]?.content).toEqual({
      text: "Refunds take 5 days [2], see also [1, 2] and [7].",
      citations: [citation(1, "kd_a"), citation(2, "kd_b")],
    });
    // DEV_NOTE: A new turn starts its own numbering, so [1] from the last turn means nothing here, and a user's
    // brackets are never read as citations
    expect(second?.messages[0]?.content).toEqual({ text: "And returns [1]?" });
    expect(second?.messages[1]?.content).toEqual({ text: "Returns are free [1]." });
  });

  it("returns nothing when everything is synced", () => {
    expect(
      unsynced([user("u1", "Q"), assistant("a1", "A")], { lastSyncedMessageId: "a1" }),
    ).toEqual({ turns: [], isPositionLost: false });
  });
});

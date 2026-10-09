import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import TranscriptProvider from "@/providers/transcript";

// DEV_NOTE: Unit tests for how the Think transcript maps onto the messages read model: no DO, no database

const user = (id: string, text: string) => ({ id, role: "user" as const, text });
const assistant = (id: string, text: string) => ({ id, role: "assistant" as const, text });

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
      { id: "u", role: "user", text: "Hi" },
      { id: "a", role: "assistant", text: "Hello there" },
      { id: "s", role: "other", text: "sys" },
    ]);
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
      { id: "s1", role: "other", text: "sys" },
    ]);
    expect(result.turns[0]?.lastEntryId).toBe("s1");
    expect(result.turns[0]?.messages.map((message) => message.sessionMessageId)).toEqual(["u1"]);
  });

  it("returns nothing when everything is synced", () => {
    expect(
      unsynced([user("u1", "Q"), assistant("a1", "A")], { lastSyncedMessageId: "a1" }),
    ).toEqual({ turns: [], isPositionLost: false });
  });
});

import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import TranscriptProvider from "@/providers/transcript";

// DEV_NOTE: Unit tests for how the Think transcript maps onto the messages read model: no DO, no database

const user = (id: string, text: string) => ({ id, role: "user" as const, text });
const assistant = (id: string, text: string) => ({ id, role: "assistant" as const, text });

function turns(
  entries: ReturnType<typeof TranscriptProvider.toEntries>,
  options: {
    syncedCount?: number;
    turnIds?: Record<string, string>;
    lastSyncedTurnId?: string | null;
  } = {},
) {
  let minted = 0;
  return TranscriptProvider.unsyncedTurns({
    entries,
    syncedCount: options.syncedCount ?? 0,
    turnIds: options.turnIds ?? {},
    lastSyncedTurnId: options.lastSyncedTurnId ?? null,
    mintTurnId: () => `minted-${++minted}`,
    titleMaxChars: 10,
  });
}

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
    const result = turns(
      [
        user("u1", "First question"),
        assistant("a1", "One"),
        user("u2", "Second"),
        assistant("a2", "Two"),
      ],
      { turnIds: { u1: "turn-1", u2: "turn-2" } },
    );
    expect(result).toEqual([
      {
        turnId: "turn-1",
        userMessageId: "u1",
        title: "First ques",
        entryCount: 2,
        messages: [
          {
            sessionMessageId: "u1",
            role: Schemas.MessageRoleIntEnum.User,
            content: { text: "First question" },
          },
          {
            sessionMessageId: "a1",
            role: Schemas.MessageRoleIntEnum.Assistant,
            content: { text: "One" },
          },
        ],
      },
      {
        turnId: "turn-2",
        userMessageId: "u2",
        title: "Second",
        entryCount: 2,
        messages: [
          {
            sessionMessageId: "u2",
            role: Schemas.MessageRoleIntEnum.User,
            content: { text: "Second" },
          },
          {
            sessionMessageId: "a2",
            role: Schemas.MessageRoleIntEnum.Assistant,
            content: { text: "Two" },
          },
        ],
      },
    ]);
  });

  it("starts after the synced position, and mints a turn id that was lost", () => {
    const result = turns(
      [user("u1", "Old"), assistant("a1", "Old reply"), user("u2", "Cut by an eviction")],
      {
        syncedCount: 2,
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ turnId: "minted-1", userMessageId: "u2", entryCount: 1 });
  });

  it("puts a reply that landed after its user message was synced under the last synced turn", () => {
    const result = turns([user("u1", "Q"), assistant("a1", "Late reply")], {
      syncedCount: 1,
      lastSyncedTurnId: "turn-1",
    });
    expect(result).toEqual([
      {
        turnId: "turn-1",
        userMessageId: null,
        title: null,
        entryCount: 1,
        messages: [
          {
            sessionMessageId: "a1",
            role: Schemas.MessageRoleIntEnum.Assistant,
            content: { text: "Late reply" },
          },
        ],
      },
    ]);
  });

  it("counts but doesn't write entries with no text or another role", () => {
    const result = turns([
      user("u1", "Q"),
      assistant("a1", ""),
      { id: "s1", role: "other", text: "sys" },
    ]);
    expect(result[0]?.entryCount).toBe(3);
    expect(result[0]?.messages.map((message) => message.sessionMessageId)).toEqual(["u1"]);
  });

  it("returns nothing when everything is synced", () => {
    expect(turns([user("u1", "Q"), assistant("a1", "A")], { syncedCount: 2 })).toEqual([]);
  });
});

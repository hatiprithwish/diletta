import { describe, it, expect } from "vitest";
import * as Schemas from "@app/schemas";
import ConversationTranscriptProvider from "@/providers/conversationTranscript";

// DEV_NOTE: Unit tests for the dashboard transcript (M4-4): no database. Turns by turn id, ordered by their first row;
// entries user → tools → replies; costs summed exactly, with the no-turn calls only in the conversation's total.

const T1 = "01J0000000000000000000000A";
const T2 = "01J0000000000000000000000B";
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 9, 0, seconds));

const message = (
  overrides: Partial<Schemas.TranscriptMessageRow> & Pick<Schemas.TranscriptMessageRow, "turnId">,
): Schemas.TranscriptMessageRow => ({
  id: "1",
  publicId: `msg_${Math.random()}`,
  companyId: "10",
  conversationId: "20",
  sessionMessageId: `s_${Math.random()}`,
  role: Schemas.MessageRoleIntEnum.User,
  content: { text: "Hello" },
  createdAt: at(0),
  updatedAt: at(0),
  rating: null,
  ...overrides,
});

const toolCall = (
  overrides: Partial<Schemas.TranscriptToolCallRow> & Pick<Schemas.TranscriptToolCallRow, "turnId">,
): Schemas.TranscriptToolCallRow => ({
  publicId: `tc_${Math.random()}`,
  toolName: "update_record",
  toolVersion: 3,
  status: Schemas.ToolCallStatusIntEnum.Ok,
  errorCode: null,
  createdAt: at(1),
  change: null,
  ...overrides,
});

const cost = (
  overrides: Partial<Schemas.ConversationTurnCostRow>,
): Schemas.ConversationTurnCostRow => ({
  turnId: T1,
  costUsd: "0.000000",
  pendingCount: 0,
  unknownCount: 0,
  firstAt: at(0),
  ...overrides,
});

describe("ConversationTranscriptProvider.buildTranscript", () => {
  it("groups by turn id, orders turns by their first row and entries user → tools → replies", () => {
    const transcript = ConversationTranscriptProvider.buildTranscript({
      messages: [
        message({ turnId: T2, content: { text: "Close them" }, createdAt: at(30) }),
        message({
          turnId: T1,
          role: Schemas.MessageRoleIntEnum.Assistant,
          content: { text: "3 are open [1]" },
          createdAt: at(5),
        }),
        message({ turnId: T1, content: { text: "Which are open?" }, createdAt: at(0) }),
      ],
      toolCalls: [toolCall({ turnId: T1, createdAt: at(2) })],
      turnCosts: [],
    });

    expect(transcript.turns.map((turn) => turn.number)).toEqual([1, 2]);
    const [first, second] = transcript.turns;
    expect(first!.startedAt).toBe(at(0).toISOString());
    expect(
      first!.entries.map((entry) =>
        entry.kind === Schemas.ConversationTurnEntryKindEnum.Message ? entry.text : entry.toolName,
      ),
    ).toEqual(["Which are open?", "update_record", "3 are open [1]"]);
    expect(second!.entries).toHaveLength(1);
  });

  it("adds a turn that only has model calls (a turn that failed before any message was stored)", () => {
    const transcript = ConversationTranscriptProvider.buildTranscript({
      messages: [message({ turnId: T2, createdAt: at(30) })],
      toolCalls: [],
      turnCosts: [cost({ turnId: T1, costUsd: "0.004000", firstAt: at(1) })],
    });
    expect(transcript.turns).toHaveLength(2);
    expect(transcript.turns[0]).toMatchObject({ number: 1, costUsd: "0.004000", entries: [] });
  });

  it("sums costs exactly per turn, and puts calls with no turn only in the total", () => {
    const transcript = ConversationTranscriptProvider.buildTranscript({
      messages: [message({ turnId: T1 }), message({ turnId: T2, createdAt: at(30) })],
      toolCalls: [],
      turnCosts: [
        cost({ turnId: T1, costUsd: "0.100000" }),
        cost({ turnId: T2, costUsd: "0.200000", firstAt: at(30) }),
        cost({ turnId: null, costUsd: "0.000001" }),
      ],
    });
    expect(transcript.turns.map((turn) => turn.costUsd)).toEqual(["0.100000", "0.200000"]);
    // DEV_NOTE: 0.1 + 0.2 in floats is 0.30000000000000004
    expect(transcript.costUsd).toBe("0.300001");
    expect(transcript.costNote).toBeNull();
  });

  it("notes Pending and Unknown costs, Unknown first", () => {
    const transcript = ConversationTranscriptProvider.buildTranscript({
      messages: [message({ turnId: T1 }), message({ turnId: T2, createdAt: at(30) })],
      toolCalls: [],
      turnCosts: [
        cost({ turnId: T1, pendingCount: 1 }),
        cost({ turnId: T2, unknownCount: 1, firstAt: at(30) }),
      ],
    });
    expect(transcript.turns.map((turn) => turn.costNote)).toEqual([
      Schemas.ConversationCostNoteEnum.Pending,
      Schemas.ConversationCostNoteEnum.Unknown,
    ]);
    expect(transcript.costNote).toBe(Schemas.ConversationCostNoteEnum.Unknown);
  });

  it("shows a purged or unreadable message as no text, and keeps citations without excerpts", () => {
    const transcript = ConversationTranscriptProvider.buildTranscript({
      messages: [
        message({ turnId: T1, content: null }),
        message({
          turnId: T1,
          role: Schemas.MessageRoleIntEnum.Assistant,
          content: {
            text: "See [1]",
            citations: [
              { n: 1, documentPublicId: "doc_1", title: "Fire drills", sourceUrl: "https://a.b/c" },
            ],
          },
          rating: Schemas.FeedbackRatingIntEnum.Down,
        }),
        message({ turnId: T1, content: { nope: true } }),
      ],
      toolCalls: [],
      turnCosts: [],
    });
    const entries = transcript.turns[0]!.entries;
    expect(entries.map((entry) => entry.kind === "message" && entry.text)).toEqual([
      null,
      null,
      "See [1]",
    ]);
    expect(entries[2]).toMatchObject({
      citations: [{ n: 1, title: "Fire drills", sourceUrl: "https://a.b/c" }],
      rating: Schemas.FeedbackRatingIntEnum.Down,
      ratingLabel: Schemas.FeedbackRatingLabelEnum.Down,
    });
    expect(JSON.stringify(entries[2])).not.toContain("doc_1");
  });

  it("labels tool and change errors, and reads an unknown tool error code as a server error", () => {
    const transcript = ConversationTranscriptProvider.buildTranscript({
      messages: [],
      toolCalls: [
        toolCall({
          turnId: T1,
          change: {
            publicId: "cr_1",
            summary: "update_record: 3 records",
            changeCount: 3,
            status: Schemas.ChangeRequestStatusIntEnum.NeedsHuman,
            errorCode: Schemas.ChangeRequestErrorCodeEnum.UndoFailed,
          },
        }),
        toolCall({
          turnId: T1,
          status: Schemas.ToolCallStatusIntEnum.Error,
          errorCode: "something_new",
        }),
      ],
      turnCosts: [],
    });
    const [write, failed] = transcript.turns[0]!.entries;
    expect(write).toMatchObject({
      change: {
        changeRequestStatusLabel: Schemas.ChangeRequestStatusLabelEnum.NeedsHuman,
        errorLabel: Schemas.CHANGE_REQUEST_ERROR_LABEL_MAP.undo_failed,
      },
    });
    expect(failed).toMatchObject({
      errorCode: Schemas.ToolCallErrorCodeEnum.ServerError,
      errorLabel: Schemas.TOOL_CALL_ERROR_LABEL_MAP.server_error,
    });
  });
});

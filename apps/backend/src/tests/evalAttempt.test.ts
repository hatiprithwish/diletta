import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";
import EvalAttemptProvider from "@/providers/evalAttempt";

// DEV_NOTE: The pure parts of an eval attempt (M5-2): what the harness grades is what the chatbot did after the case's
// last message, never a line the case seeded
const text = (id: string, role: UIMessage["role"], value: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: value }],
});

describe("EvalAttemptProvider", () => {
  it("ends the turn's messages on the user's question, every one with its own id", () => {
    const { saved, userMessageId } = EvalAttemptProvider.toTurnMessages([
      { role: Schemas.EvalCaseMessageRoleEnum.User, text: "Update a record" },
      { role: Schemas.EvalCaseMessageRoleEnum.Assistant, text: "Which record?" },
      { role: Schemas.EvalCaseMessageRoleEnum.User, text: "Alpha" },
    ]);
    expect(saved).toHaveLength(3);
    expect(saved.at(-1)?.id).toBe(userMessageId);
    expect(new Set(saved.map((message) => message.id)).size).toBe(3);
  });

  it("never grades a seeded assistant line as the reply, and flags writes the eval approved", () => {
    const messages: UIMessage[] = [
      text("m1", "user", "Update a record"),
      text("m2", "assistant", "Which record?"),
      text("m3", "user", "Alpha, to 300"),
      {
        id: "m4",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "update_record",
            toolCallId: "call_1",
            state: "output-available",
            input: { recordId: "rec_alpha", amount: 300 },
            output: {
              status: Schemas.HostToolStatusEnum.Verified,
              message: "Done",
              changeRequestId: "cr_1",
            },
          },
        ],
      },
    ];
    const summary = EvalAttemptProvider.summarize(messages, "m3", new Set(["cr_1"]));
    expect(summary.reply).toBe("");
    expect(summary.toolCalls).toEqual([
      {
        toolCallId: "call_1",
        toolName: "update_record",
        args: { recordId: "rec_alpha", amount: 300 },
        status: Schemas.HostToolStatusEnum.Verified,
        changeRequestId: "cr_1",
        wasApprovalRequired: true,
      },
    ]);
    expect(
      EvalAttemptProvider.summarize(messages, "m3", new Set()).toolCalls[0]?.wasApprovalRequired,
    ).toBe(false);
  });

  it("lists the whole conversation for its transcript, a tool call where it ran, never its args", () => {
    const messages: UIMessage[] = [
      text("m1", "user", "Set Alpha to 300"),
      {
        id: "m2",
        role: "assistant",
        parts: [
          { type: "text", text: "Updating it now. " },
          {
            type: "dynamic-tool",
            toolName: "update_record",
            toolCallId: "call_1",
            state: "output-available",
            input: { recordId: "rec_alpha", amount: 300 },
            output: {
              status: Schemas.HostToolStatusEnum.Verified,
              message: "Done",
              changeRequestId: "cr_1",
            },
          },
          {
            type: "dynamic-tool",
            toolName: "get_record",
            toolCallId: "call_2",
            state: "input-available",
            input: { recordId: "rec_alpha" },
          },
          { type: "text", text: "Alpha is now 300." },
        ],
      },
      { id: "m3", role: "system", parts: [{ type: "text", text: "Not part of the chat" }] },
      text("m4", "assistant", "   "),
    ];
    expect(EvalAttemptProvider.entries(messages)).toEqual([
      {
        kind: Schemas.EvalAttemptEntryKindEnum.Message,
        role: Schemas.EvalCaseMessageRoleEnum.User,
        text: "Set Alpha to 300",
      },
      {
        kind: Schemas.EvalAttemptEntryKindEnum.Message,
        role: Schemas.EvalCaseMessageRoleEnum.Assistant,
        text: "Updating it now.",
      },
      {
        kind: Schemas.EvalAttemptEntryKindEnum.ToolCall,
        toolName: "update_record",
        status: Schemas.HostToolStatusEnum.Verified,
        changeRequestId: "cr_1",
      },
      {
        kind: Schemas.EvalAttemptEntryKindEnum.ToolCall,
        toolName: "get_record",
        status: null,
        changeRequestId: null,
      },
      {
        kind: Schemas.EvalAttemptEntryKindEnum.Message,
        role: Schemas.EvalCaseMessageRoleEnum.Assistant,
        text: "Alpha is now 300.",
      },
    ]);
  });
});

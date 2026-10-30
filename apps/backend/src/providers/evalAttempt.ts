import type { UIMessage } from "ai";
import TranscriptProvider from "@/providers/transcript";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The pure parts of an eval attempt (M5-2) that ConversationDO.runEvalAttempt runs: the case's messages as
// the turn's saved messages, Think's turn status as the harness reads it, and the attempt's transcript as it grades it
// (the last reply, every tool call). No state, database or host call: the DO holds those.
export default class EvalAttemptProvider {
  // DEV_NOTE: The case's messages, each a text message with a new ULID, saved and answered as one turn (saveMessages).
  // userMessageId is the last one's: the user's question the turn answers (ZEvalCaseMessages ends with it).
  static toTurnMessages(messages: Schemas.EvalCaseMessage[]): {
    saved: UIMessage[];
    userMessageId: string;
  } {
    const userMessageId = Utility.generateUlid();
    const saved = messages.map((message, index) => ({
      id: index === messages.length - 1 ? userMessageId : Utility.generateUlid(),
      role: message.role,
      parts: [{ type: "text" as const, text: message.text }],
    }));
    return { saved, userMessageId };
  }

  // DEV_NOTE: Think's saveMessages status; anything else is Error
  static turnStatus(status: string): Schemas.EvalTurnStatusEnum {
    const parsed = Schemas.ZEvalTurnStatus.safeParse(status);
    return parsed.success ? parsed.data : Schemas.EvalTurnStatusEnum.Error;
  }

  // DEV_NOTE: What the chatbot did = the transcript after the case's last (user) message: its last non-empty reply (""
  // when none: a seeded assistant line of the case is never taken for one) and every tool call, in order.
  // approvedByEval: the change requests the eval approved on the user's behalf (wasApprovalRequired).
  static summarize(
    messages: UIMessage[],
    userMessageId: string,
    approvedByEval: ReadonlySet<string>,
  ): { reply: string; toolCalls: Schemas.EvalAttemptToolCall[] } {
    const asked = messages.findIndex((message) => message.id === userMessageId);
    const attempt = asked < 0 ? [] : messages.slice(asked + 1);
    const replies = TranscriptProvider.toEntries(
      attempt.filter((message) => message.role === "assistant"),
    ).filter((entry) => entry.text.length > 0);
    return {
      reply: replies.at(-1)?.text ?? "",
      toolCalls: attempt.flatMap((message) =>
        message.parts.flatMap((part) => EvalAttemptProvider.toolCall(part, approvedByEval)),
      ),
    };
  }

  // DEV_NOTE: One tool part of the transcript as the eval harness grades it: name, the model's args, how it ended (a
  // host tool's own status; search_help_docs is Ok once it answered) and a write's change request. Other parts: none.
  static toolCall(
    part: UIMessage["parts"][number],
    approvedByEval: ReadonlySet<string>,
  ): Schemas.EvalAttemptToolCall[] {
    const toolName =
      part.type === "dynamic-tool"
        ? part.toolName
        : part.type.startsWith("tool-")
          ? part.type.slice("tool-".length)
          : null;
    if (toolName === null || !("toolCallId" in part) || !("state" in part)) return [];
    const args = Schemas.ZEvalToolArgs.safeParse("input" in part ? part.input : null);
    let status: Schemas.HostToolStatusEnum | null = null;
    let changeRequestId: string | null = null;
    if (part.state === "output-available") {
      const output = Schemas.ZHostToolOutput.safeParse(part.output);
      if (output.success) {
        status = output.data.status;
        changeRequestId = output.data.changeRequestId ?? null;
      } else if (toolName === Schemas.SEARCH_HELP_DOCS_TOOL_NAME) {
        status = Schemas.HostToolStatusEnum.Ok;
      }
    } else if (part.state === "output-error") {
      status = Schemas.HostToolStatusEnum.Error;
    }
    return [
      {
        toolCallId: part.toolCallId,
        toolName,
        args: args.success ? args.data : null,
        status,
        changeRequestId,
        wasApprovalRequired: changeRequestId !== null && approvedByEval.has(changeRequestId),
      },
    ];
  }
}

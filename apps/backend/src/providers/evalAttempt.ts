import type { UIMessage } from "ai";
import TranscriptProvider from "@/providers/transcript";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: The pure parts of an eval attempt (M5-2) that ConversationDO.runEvalAttempt runs: the case's messages as
// the turn's saved messages, Think's turn status as the harness reads it, and the attempt's transcript as it grades it
// (the last reply, every tool call). No state, database or host call: the DO holds those.
export default class EvalAttemptProvider {
  // DEV_NOTE: The case's messages, each a text message with a new ULID, saved and answered as one turn (saveMessages)
  static toUIMessages(messages: Schemas.EvalCaseMessage[]): UIMessage[] {
    return messages.map((message) => ({
      id: Utility.generateUlid(),
      role: message.role,
      parts: [{ type: "text", text: message.text }],
    }));
  }

  // DEV_NOTE: Think's saveMessages status; anything else is Error
  static turnStatus(status: string): Schemas.EvalTurnStatusEnum {
    const parsed = Schemas.ZEvalTurnStatus.safeParse(status);
    return parsed.success ? parsed.data : Schemas.EvalTurnStatusEnum.Error;
  }

  // DEV_NOTE: The attempt = the transcript from its first saved message on: the last non-empty assistant reply ("" when
  // none) and every tool call, in order
  static summarize(
    messages: UIMessage[],
    firstId: string,
  ): { reply: string; toolCalls: Schemas.EvalAttemptToolCall[] } {
    const start = messages.findIndex((message) => message.id === firstId);
    const attempt = start < 0 ? [] : messages.slice(start);
    const replies = TranscriptProvider.toEntries(
      attempt.filter((message) => message.role === "assistant"),
    ).filter((entry) => entry.text.length > 0);
    return {
      reply: replies.at(-1)?.text ?? "",
      toolCalls: attempt.flatMap((message) =>
        message.parts.flatMap((part) => EvalAttemptProvider.toolCall(part)),
      ),
    };
  }

  // DEV_NOTE: One tool part of the transcript as the eval harness grades it: name, the model's args, how it ended (a
  // host tool's own status; search_help_docs is Ok once it answered) and a write's change request. Other parts: none.
  static toolCall(part: UIMessage["parts"][number]): Schemas.EvalAttemptToolCall[] {
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
      },
    ];
  }
}

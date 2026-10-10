import { getToolName, isTextUIPart, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Think's transcript (UIMessage[], from the socket) as the panel shows it (Schemas.WidgetMessageView). Pure.
// A reply is its text parts (one per model step, joined as paragraphs), its tool calls as steps, and the sources its
// [n] markers cite, looked up in every search_help_docs result of that reply. Tool outputs come from the server and
// are parsed, never trusted: an output that doesn't parse (or that Think trimmed) shows as a finished step with no
// detail and adds no sources.
const SEARCH_DETAIL = (count: number) => (count === 1 ? "1 result" : `${count} results`);

function toStep(part: Parameters<typeof getToolName>[0]): Schemas.WidgetToolStep {
  const isSearch = getToolName(part) === Schemas.SEARCH_HELP_DOCS_TOOL_NAME;
  const id = part.toolCallId;

  if (part.state === "output-error" || part.state === "output-denied") {
    return {
      id,
      label: isSearch ? "Couldn't search the help docs" : "Step failed",
      detail: null,
      state: Schemas.WidgetToolStepStateEnum.Failed,
    };
  }
  if (part.state !== "output-available") {
    return {
      id,
      label: isSearch ? "Searching the help docs" : "Working",
      detail: null,
      state: Schemas.WidgetToolStepStateEnum.Running,
    };
  }
  if (!isSearch) {
    return { id, label: "Done", detail: null, state: Schemas.WidgetToolStepStateEnum.Done };
  }

  const output = Schemas.ZSearchHelpDocsOutput.safeParse(part.output);
  if (output.success && output.data.status === Schemas.SearchHelpDocsStatusEnum.Unavailable) {
    return {
      id,
      label: "Couldn't search the help docs",
      detail: null,
      state: Schemas.WidgetToolStepStateEnum.Failed,
    };
  }
  return {
    id,
    label: "Searched the help docs",
    detail: output.success ? SEARCH_DETAIL(output.data.results.length) : null,
    state: Schemas.WidgetToolStepStateEnum.Done,
  };
}

function searchCitations(message: UIMessage): Schemas.KnowledgeCitation[] {
  return message.parts.flatMap((part) => {
    if (!isToolUIPart(part) || getToolName(part) !== Schemas.SEARCH_HELP_DOCS_TOOL_NAME) return [];
    if (part.state !== "output-available") return [];
    const output = Schemas.ZSearchHelpDocsOutput.safeParse(part.output);
    return output.success ? output.data.results : [];
  });
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

// DEV_NOTE: When the newest message is the user's (a send the server refused or never answered), the transcript
// without it and its text; else null
export function splitUnsent(messages: UIMessage[]): Schemas.WidgetUnsentSplit<UIMessage> | null {
  const unsent = messages.at(-1);
  if (unsent?.role !== "user") return null;
  return { messages: messages.slice(0, -1), text: textOf(unsent) };
}

export function toMessageViews(params: {
  messages: UIMessage[];
  isStreaming: boolean;
  ratings: Record<string, Schemas.FeedbackRatingIntEnum>;
  pendingRatings: Record<string, Schemas.FeedbackRatingIntEnum>;
}): Schemas.WidgetMessageView[] {
  const lastIndex = params.messages.length - 1;
  return params.messages.flatMap((message, index): Schemas.WidgetMessageView[] => {
    if (message.role === "user") {
      return [{ role: "user", id: message.id, text: textOf(message) }];
    }
    if (message.role !== "assistant") return [];

    const text = textOf(message);
    const isStreaming = params.isStreaming && index === lastIndex;
    return [
      {
        role: "assistant",
        id: message.id,
        text,
        steps: message.parts.filter(isToolUIPart).map(toStep),
        citations: Schemas.citedBy(text, searchCitations(message)),
        isStreaming,
        canRate: !isStreaming && text.length > 0,
        rating: params.pendingRatings[message.id] ?? params.ratings[message.id] ?? null,
      },
    ];
  });
}

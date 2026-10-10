import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import * as Schemas from "@app/schemas";
import { toMessageViews } from "@/lib/transcriptView";

// DEV_NOTE: Think's transcript → the panel's view: steps, the sources a reply cites, and when thumbs are offered
const citation = (n: number): Schemas.KnowledgeCitation => ({
  n,
  documentPublicId: `doc-${n}`,
  title: `Doc ${n}`,
  sourceUrl: `https://help.example.com/${n}`,
});

const searchPart = (state: string, output?: unknown) =>
  ({
    type: `tool-${Schemas.SEARCH_HELP_DOCS_TOOL_NAME}`,
    toolCallId: `call-${state}`,
    state,
    input: { query: "custom field" },
    ...(output === undefined ? {} : { output }),
  }) as UIMessage["parts"][number];

const transcript = (assistantParts: UIMessage["parts"]): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text: "How do I add a field?" }] },
  { id: "a1", role: "assistant", parts: assistantParts },
];

describe("toMessageViews", () => {
  it("shows a reply's search as a step and lists only the sources its markers cite", () => {
    const views = toMessageViews({
      messages: transcript([
        searchPart("output-available", {
          status: Schemas.SearchHelpDocsStatusEnum.Found,
          results: [citation(1), citation(2), citation(3)],
        }),
        { type: "text", text: "Open settings [1]. Then save [3]." },
      ]),
      isStreaming: false,
      ratings: { a1: Schemas.FeedbackRatingIntEnum.Up },
      pendingRatings: {},
    });
    expect(views[0]).toEqual({ role: "user", id: "u1", text: "How do I add a field?" });
    const reply = views[1];
    if (reply?.role !== "assistant") throw new Error("No reply");
    expect(reply.steps).toEqual([
      {
        id: "call-output-available",
        label: "Searched the help docs",
        detail: "3 results",
        state: Schemas.WidgetToolStepStateEnum.Done,
      },
    ]);
    expect(reply.citations.map((entry) => entry.n)).toEqual([1, 3]);
    expect(reply.canRate).toBe(true);
    expect(reply.rating).toBe(Schemas.FeedbackRatingIntEnum.Up);
  });

  it("marks a running search and a streaming reply, which can't be rated yet", () => {
    const views = toMessageViews({
      messages: transcript([searchPart("input-available")]),
      isStreaming: true,
      ratings: {},
      pendingRatings: {},
    });
    const reply = views[1];
    if (reply?.role !== "assistant") throw new Error("No reply");
    expect(reply.steps[0]?.state).toBe(Schemas.WidgetToolStepStateEnum.Running);
    expect(reply.isStreaming).toBe(true);
    expect(reply.canRate).toBe(false);
  });

  it("shows a failed or unavailable search as failed, and ignores outputs that don't parse", () => {
    const views = toMessageViews({
      messages: transcript([
        searchPart("output-error"),
        searchPart("output-available", { status: "unavailable", results: [] }),
        {
          ...searchPart("output-available", "no longer shown"),
          toolCallId: "trimmed",
        } as UIMessage["parts"][number],
        { type: "text", text: "I can't look that up [1]." },
      ]),
      isStreaming: false,
      ratings: {},
      pendingRatings: { a1: Schemas.FeedbackRatingIntEnum.Down },
    });
    const reply = views[1];
    if (reply?.role !== "assistant") throw new Error("No reply");
    expect(reply.steps.map((step) => step.state)).toEqual([
      Schemas.WidgetToolStepStateEnum.Failed,
      Schemas.WidgetToolStepStateEnum.Failed,
      Schemas.WidgetToolStepStateEnum.Done,
    ]);
    expect(reply.steps[2]?.detail).toBeNull();
    expect(reply.citations).toEqual([]);
    expect(reply.rating).toBe(Schemas.FeedbackRatingIntEnum.Down);
  });
});

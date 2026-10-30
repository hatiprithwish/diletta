import * as Schemas from "@app/schemas";

// DEV_NOTE: Text caps tried in turn when a transcript is over EVAL_TRANSCRIPT_MAX_BYTES: every message is cut to the
// first cap that fits (most attempts never get past the first, the schema's own)
const TEXT_CAPS = [Schemas.EVAL_TRANSCRIPT_TEXT_MAX_CHARS, 5_000, 1_000, 200];

// DEV_NOTE: An entry the transcript lists: a message (no version), or a tool call with the version its pin names
type AttemptEntryOf<K extends Schemas.EvalAttemptEntryKindEnum> = Extract<
  Schemas.EvalAttemptEntry,
  { kind: K }
>;
type ListedEntry =
  | {
      kind: Schemas.EvalAttemptEntryKindEnum.Message;
      entry: AttemptEntryOf<Schemas.EvalAttemptEntryKindEnum.Message>;
    }
  | {
      kind: Schemas.EvalAttemptEntryKindEnum.ToolCall;
      entry: AttemptEntryOf<Schemas.EvalAttemptEntryKindEnum.ToolCall>;
      toolVersion: number;
    };

// DEV_NOTE: An eval attempt's transcript v1 (M5-3), pure: what the Conversation DO holds of the attempt
// (getEvalTranscript: messages and tool calls, oldest first) turned into the file the Tests page reads from R2 and the
// judge grades. A tool call names the version the run's config pinned (the attempt ran exactly those pins) and ends
// with its change request's summary (no values) and how it ended. A tool the config doesn't pin (search_help_docs) has
// no version, so it isn't listed; the reply that used it is. Never args or host data (rule: the Conversations
// transcript's). Sizes are held to the schema's: texts and summaries cut with …, entries capped (the first ones and the
// last, the chatbot's reply), texts cut further until the file fits EVAL_TRANSCRIPT_MAX_BYTES. null = it still doesn't
// hold to ZEvalTranscriptV1 (a bug, never a guess).
export default class EvalTranscriptProvider {
  static build(params: {
    entries: Schemas.EvalAttemptEntry[];
    toolVersions: Record<string, number>;
    changeRequestSummaries: Record<string, string>;
  }): { transcript: Schemas.EvalTranscript; bytes: Uint8Array<ArrayBuffer> } | null {
    const listed = params.entries.flatMap((entry): ListedEntry[] => {
      if (entry.kind === Schemas.EvalAttemptEntryKindEnum.Message) {
        return [{ kind: entry.kind, entry }];
      }
      const toolVersion = Object.hasOwn(params.toolVersions, entry.toolName)
        ? params.toolVersions[entry.toolName]
        : undefined;
      return toolVersion === undefined ? [] : [{ kind: entry.kind, entry, toolVersion }];
    });
    const max = Schemas.EVAL_TRANSCRIPT_MAX_ENTRIES;
    const kept = listed.length > max ? [...listed.slice(0, max - 1), ...listed.slice(-1)] : listed;

    for (const textCap of TEXT_CAPS) {
      const transcript = {
        schemaVersion: Schemas.EVAL_TRANSCRIPT_SCHEMA_VERSION,
        entries: kept.map((listedEntry) =>
          EvalTranscriptProvider.toEntry(listedEntry, params.changeRequestSummaries, textCap),
        ),
      };
      const bytes = new Uint8Array(new TextEncoder().encode(JSON.stringify(transcript)));
      if (bytes.byteLength > Schemas.EVAL_TRANSCRIPT_MAX_BYTES) continue;
      const parsed = Schemas.ZEvalTranscriptV1.safeParse(transcript);
      return parsed.success ? { transcript: parsed.data, bytes } : null;
    }
    return null;
  }

  // DEV_NOTE: text within limit UTF-16 units (Zod's count), ending with … when cut; never splits a surrogate pair
  static cut(text: string, limit: number): string {
    if (text.length <= limit) return text;
    let end = limit - 1;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return `${text.slice(0, end)}…`;
  }

  private static toEntry(
    listed: ListedEntry,
    changeRequestSummaries: Record<string, string>,
    textCap: number,
  ): Schemas.EvalTranscript["entries"][number] {
    if (listed.kind === Schemas.EvalAttemptEntryKindEnum.Message) {
      const { entry } = listed;
      return {
        kind: Schemas.EvalTranscriptEntryKindEnum.Message,
        role: entry.role,
        text: EvalTranscriptProvider.cut(entry.text, textCap),
      };
    }
    const { entry, toolVersion } = listed;
    const ended = Schemas.EVAL_TRANSCRIPT_TOOL_STATUS_MAP[entry.status ?? "unfinished"];
    const changeSummary =
      entry.changeRequestId === null ? undefined : changeRequestSummaries[entry.changeRequestId];
    return {
      kind: Schemas.EvalTranscriptEntryKindEnum.ToolCall,
      toolName: EvalTranscriptProvider.cut(entry.toolName, Schemas.EVAL_CHECK_LABEL_MAX_CHARS),
      toolVersion,
      status: ended.status,
      summary: EvalTranscriptProvider.cut(
        changeSummary ? `${changeSummary}: ${ended.text}` : ended.text,
        Schemas.EVAL_TRANSCRIPT_SUMMARY_MAX_CHARS,
      ),
    };
  }
}

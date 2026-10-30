import * as Schemas from "@app/schemas";

// DEV_NOTE: Text caps tried in turn when a stored transcript is over EVAL_TRANSCRIPT_MAX_BYTES: every message is cut to
// the first cap that fits (most attempts never get past the first, the schema's own)
const TEXT_CAPS = [Schemas.EVAL_TRANSCRIPT_TEXT_MAX_CHARS, 5_000, 1_000, 200];
const MIDDLE_CUT = "\n…\n";

// DEV_NOTE: An eval attempt's two views (M5-3), pure, both from what its Conversation DO and change requests hold
// (Schemas.EvalAttemptRecord: messages and tool calls, oldest first, and each change request's summary). Never args or
// host data (rule: the Conversations transcript's).
//   build: transcript v1, the file the Tests page reads from R2. A tool call names the version the run's config
//     pinned (the attempt ran exactly those pins); a tool the config doesn't pin (search_help_docs) has no version, so
//     v1 can't list it. Sizes are held to the schema's: texts and summaries cut with …, entries capped (the first ones
//     and the chatbot's last reply, wherever it sits: a turn that didn't complete can end on a tool call), texts cut
//     further until the file fits EVAL_TRANSCRIPT_MAX_BYTES. The file is the parsed transcript serialized, so its
//     bytes are exactly what the page will parse. A failure says why: Invalid (a bug) or TooLarge (over the cap at
//     every cut).
//   judgeView: what the judge grades. Every tool call (search_help_docs too: a rubric may ask for answers from the help
//     docs) with how it ended; held to EVAL_JUDGE_TRANSCRIPT_MAX_CHARS so the prompt always fits the pinned models. The
//     chatbot's last reply is kept whole (cut in the middle only if it alone is over the budget), then earlier entries
//     newest first while they fit; omittedCount says how many older ones were left out.
export default class EvalTranscriptProvider {
  static build(params: {
    record: Schemas.EvalAttemptRecord;
    toolVersions: Record<string, number>;
  }): Schemas.BuildEvalTranscriptResponse {
    const { record, toolVersions } = params;
    const listed = record.entries.flatMap((entry): Schemas.EvalTranscriptListedEntry[] => {
      if (entry.kind === Schemas.EvalAttemptEntryKindEnum.Message) {
        return [{ kind: entry.kind, entry }];
      }
      const toolVersion = Object.hasOwn(toolVersions, entry.toolName)
        ? toolVersions[entry.toolName]
        : undefined;
      return toolVersion === undefined ? [] : [{ kind: entry.kind, entry, toolVersion }];
    });
    const kept = EvalTranscriptProvider.capEntries(listed);

    const encoder = new TextEncoder();
    for (const textCap of TEXT_CAPS) {
      const parsed = Schemas.ZEvalTranscriptV1.safeParse({
        schemaVersion: Schemas.EVAL_TRANSCRIPT_SCHEMA_VERSION,
        entries: kept.map((listedEntry) =>
          EvalTranscriptProvider.toStoredEntry(listedEntry, record.changeRequestSummaries, textCap),
        ),
      });
      if (!parsed.success) {
        return { isSuccess: false, failure: Schemas.EvalTranscriptBuildFailureEnum.Invalid };
      }
      const text = JSON.stringify(parsed.data);
      const bytes = encoder.encode(text);
      if (bytes.byteLength <= Schemas.EVAL_TRANSCRIPT_MAX_BYTES) {
        return { isSuccess: true, built: { transcript: parsed.data, text, bytes } };
      }
    }
    return { isSuccess: false, failure: Schemas.EvalTranscriptBuildFailureEnum.TooLarge };
  }

  // DEV_NOTE: At most EVAL_TRANSCRIPT_MAX_ENTRIES: the first ones, and the chatbot's last reply when it would be cut
  // off
  private static capEntries(
    listed: Schemas.EvalTranscriptListedEntry[],
  ): Schemas.EvalTranscriptListedEntry[] {
    const max = Schemas.EVAL_TRANSCRIPT_MAX_ENTRIES;
    if (listed.length <= max) return listed;
    const lastReply = EvalTranscriptProvider.lastIndex(
      listed,
      (listedEntry) =>
        listedEntry.kind === Schemas.EvalAttemptEntryKindEnum.Message &&
        listedEntry.entry.role === Schemas.EvalCaseMessageRoleEnum.Assistant,
    );
    const reply = lastReply >= max - 1 ? listed[lastReply] : undefined;
    return reply ? [...listed.slice(0, max - 1), reply] : listed.slice(0, max);
  }

  // DEV_NOTE: The index of the last item that matches, -1 when none (Array.findLastIndex isn't in the worker's lib)
  private static lastIndex<T>(items: T[], matches: (item: T) => boolean): number {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item !== undefined && matches(item)) return index;
    }
    return -1;
  }

  static judgeView(record: Schemas.EvalAttemptRecord): Schemas.EvalJudgeTranscript {
    const entries = record.entries.map((entry) =>
      EvalTranscriptProvider.toJudgeEntry(entry, record.changeRequestSummaries),
    );
    const budget = Schemas.EVAL_JUDGE_TRANSCRIPT_MAX_CHARS;
    const lastReply = EvalTranscriptProvider.lastIndex(
      entries,
      (entry) =>
        entry.kind === Schemas.EvalAttemptEntryKindEnum.Message &&
        entry.role === Schemas.EvalCaseMessageRoleEnum.Assistant,
    );

    const kept = new Set<number>();
    let spent = 0;
    const reply = entries[lastReply];
    if (reply?.kind === Schemas.EvalAttemptEntryKindEnum.Message) {
      const text = EvalTranscriptProvider.cutMiddle(reply.text, budget);
      entries[lastReply] = { ...reply, text };
      kept.add(lastReply);
      spent += text.length;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (kept.has(index)) continue;
      const entry = entries[index];
      if (!entry) continue;
      const size = EvalTranscriptProvider.judgeSize(entry);
      if (spent + size > budget) break;
      kept.add(index);
      spent += size;
    }

    return {
      entries: entries.filter((_entry, index) => kept.has(index)),
      omittedCount: entries.length - kept.size,
    };
  }

  // DEV_NOTE: text within limit UTF-16 units (Zod's count), ending with … when cut; never splits a surrogate pair
  static cut(text: string, limit: number): string {
    if (text.length <= limit) return text;
    let end = limit - 1;
    if (EvalTranscriptProvider.isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    return `${text.slice(0, end)}…`;
  }

  // DEV_NOTE: text within limit, its start and its end kept (a check on how a long reply ends still sees it)
  static cutMiddle(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const half = Math.floor((limit - MIDDLE_CUT.length) / 2);
    let start = half;
    if (EvalTranscriptProvider.isHighSurrogate(text.charCodeAt(start - 1))) start -= 1;
    let end = text.length - half;
    if (EvalTranscriptProvider.isHighSurrogate(text.charCodeAt(end - 1))) end += 1;
    return `${text.slice(0, start)}${MIDDLE_CUT}${text.slice(end)}`;
  }

  private static isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
  }

  // DEV_NOTE: How a tool call ended: tool_calls' status, and its change request's summary before the words for it
  private static outcome(
    entry: Schemas.EvalAttemptEntryOf<Schemas.EvalAttemptEntryKindEnum.ToolCall>,
    changeRequestSummaries: Record<string, string>,
  ): { status: Schemas.ToolCallStatusIntEnum; text: string } {
    const ended = Schemas.EVAL_TRANSCRIPT_TOOL_STATUS_MAP[entry.status ?? "unfinished"];
    const changeSummary =
      entry.changeRequestId === null ? undefined : changeRequestSummaries[entry.changeRequestId];
    return {
      status: ended.status,
      text: changeSummary ? `${changeSummary}: ${ended.text}` : ended.text,
    };
  }

  private static toStoredEntry(
    listed: Schemas.EvalTranscriptListedEntry,
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
    const { status, text } = EvalTranscriptProvider.outcome(entry, changeRequestSummaries);
    return {
      kind: Schemas.EvalTranscriptEntryKindEnum.ToolCall,
      toolName: EvalTranscriptProvider.cut(entry.toolName, Schemas.EVAL_CHECK_LABEL_MAX_CHARS),
      toolVersion,
      status,
      summary: EvalTranscriptProvider.cut(text, Schemas.EVAL_TRANSCRIPT_SUMMARY_MAX_CHARS),
    };
  }

  private static toJudgeEntry(
    entry: Schemas.EvalAttemptEntry,
    changeRequestSummaries: Record<string, string>,
  ): Schemas.EvalJudgeEntry {
    if (entry.kind === Schemas.EvalAttemptEntryKindEnum.Message) return entry;
    return {
      kind: entry.kind,
      toolName: EvalTranscriptProvider.cut(entry.toolName, Schemas.EVAL_CHECK_LABEL_MAX_CHARS),
      outcome: EvalTranscriptProvider.cut(
        EvalTranscriptProvider.outcome(entry, changeRequestSummaries).text,
        Schemas.EVAL_TRANSCRIPT_SUMMARY_MAX_CHARS,
      ),
    };
  }

  // DEV_NOTE: An entry's share of the judge's budget: its text, or a tool call's name and outcome
  private static judgeSize(entry: Schemas.EvalJudgeEntry): number {
    return entry.kind === Schemas.EvalAttemptEntryKindEnum.Message
      ? entry.text.length
      : entry.toolName.length + entry.outcome.length;
  }
}

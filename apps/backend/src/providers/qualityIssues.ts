import * as Schemas from "@app/schemas";

// DEV_NOTE: One message as the Quality page reads it: who said it and its text (a tool message, or one with no text, is
// left out)
type ChatLine = { id: string; role: Schemas.MessageRoleIntEnum; text: string; rowIndex: number };

// DEV_NOTE: Where the issue's reply sits: end = how many lines come before it, anchor = its line (null when it has no
// text, or there is no reply at all)
type AnchorPosition = { end: number; anchor: ChatLine | null };

// DEV_NOTE: What an issue is about, picked from its conversation's messages (M4-6), pure so it is unit-tested on its
// own. The anchor is the reply the issue is about: the rated reply for a user issue, else the conversation's last
// reply. Messages are read from the read model (messages.content through Schemas.ZMessageContent; null once purged,
// so a purged chat has no excerpt and nothing to turn into a test).
export default class QualityIssuesProvider {
  // DEV_NOTE: The list's line for a user issue: the start of the rated reply, cut at QUALITY_ISSUE_EXCERPT_MAX_CHARS
  static ratedReply(content: unknown): string | null {
    const parsed = Schemas.ZMessageContent.safeParse(content);
    if (!parsed.success) return null;
    const text = parsed.data.text.trim();
    if (text === "") return null;
    return QualityIssuesProvider.cut(text, Schemas.QUALITY_ISSUE_EXCERPT_MAX_CHARS);
  }

  // DEV_NOTE: The detail card's excerpt: the anchor and the user message just before it (either may be missing), or the
  // last user message when nothing was answered yet
  static excerpt(
    rows: Schemas.TranscriptMessageRow[],
    ratedMessageId: string | null,
  ): Schemas.QualityIssueExcerptMessage[] {
    const lines = QualityIssuesProvider.lines(rows);
    const { end, anchor } = QualityIssuesProvider.anchor(rows, lines, ratedMessageId);
    const questionIndex = QualityIssuesProvider.lastIndexOf(
      lines.slice(0, end),
      Schemas.MessageRoleIntEnum.User,
    );
    const question = questionIndex === -1 ? undefined : lines[questionIndex];
    return [question, anchor ?? undefined]
      .filter((line): line is ChatLine => line !== undefined)
      .map(({ role, text }) => ({ role, text }));
  }

  // DEV_NOTE: What the rewrite model is shown: the conversation before the anchor, ending with the user's question (a
  // trailing reply is dropped), its last EVAL_CASE_MAX_MESSAGES messages, each cut at EVAL_CASE_MESSAGE_MAX_CHARS, and
  // the anchor as the reply that went wrong. null = no user question to test (purged, or the user never asked one).
  static rewriteSource(
    rows: Schemas.TranscriptMessageRow[],
    ratedMessageId: string | null,
    triage: Pick<Schemas.QualityTestRewriteSource, "issueTypeLabel" | "note">,
  ): Schemas.QualityTestRewriteSource | null {
    const lines = QualityIssuesProvider.lines(rows);
    const { end, anchor } = QualityIssuesProvider.anchor(rows, lines, ratedMessageId);
    const before = lines.slice(0, end);
    const lastQuestion = QualityIssuesProvider.lastIndexOf(before, Schemas.MessageRoleIntEnum.User);
    if (lastQuestion === -1) return null;

    const messages = before
      .slice(0, lastQuestion + 1)
      .slice(-Schemas.EVAL_CASE_MAX_MESSAGES)
      .map((line) => ({
        role:
          line.role === Schemas.MessageRoleIntEnum.User
            ? Schemas.EvalCaseMessageRoleEnum.User
            : Schemas.EvalCaseMessageRoleEnum.Assistant,
        text: QualityIssuesProvider.cut(line.text, Schemas.EVAL_CASE_MESSAGE_MAX_CHARS),
      }));
    return {
      messages,
      reply: anchor
        ? QualityIssuesProvider.cut(anchor.text, Schemas.EVAL_CASE_MESSAGE_MAX_CHARS)
        : null,
      issueTypeLabel: triage.issueTypeLabel,
      note: triage.note,
    };
  }

  // DEV_NOTE: A user issue's reply is the rated one, wherever it sits, even with no text (then only what came before it
  // is used, never another reply). Any other issue, or a rated reply missing from the rows, is about the last reply.
  private static anchor(
    rows: Schemas.TranscriptMessageRow[],
    lines: ChatLine[],
    ratedMessageId: string | null,
  ): AnchorPosition {
    const ratedRowIndex =
      ratedMessageId === null ? -1 : rows.findIndex((row) => row.id === ratedMessageId);
    if (ratedRowIndex !== -1) {
      return {
        end: lines.filter((line) => line.rowIndex < ratedRowIndex).length,
        anchor: lines.find((line) => line.rowIndex === ratedRowIndex) ?? null,
      };
    }
    const last = QualityIssuesProvider.lastIndexOf(lines, Schemas.MessageRoleIntEnum.Assistant);
    return last === -1
      ? { end: lines.length, anchor: null }
      : { end: last, anchor: lines[last] ?? null };
  }

  // DEV_NOTE: User and assistant messages with text, oldest first (the DAL reads them in id order)
  private static lines(rows: Schemas.TranscriptMessageRow[]): ChatLine[] {
    const lines: ChatLine[] = [];
    for (const [rowIndex, row] of rows.entries()) {
      if (row.role === Schemas.MessageRoleIntEnum.Tool) continue;
      const content = Schemas.ZMessageContent.safeParse(row.content);
      if (!content.success) continue;
      const text = content.data.text.trim();
      if (text === "") continue;
      lines.push({ id: row.id, role: row.role, text, rowIndex });
    }
    return lines;
  }

  // DEV_NOTE: The last line of that role, -1 = none (the Worker's lib has no findLastIndex)
  private static lastIndexOf(lines: ChatLine[], role: Schemas.MessageRoleIntEnum): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]?.role === role) return index;
    }
    return -1;
  }

  private static cut(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
  }
}

import * as Schemas from "@app/schemas";

// DEV_NOTE: One message as the Quality page reads it: who said it and its text (one with no text is left out)
type ChatLine = { id: string; role: Schemas.MessageRoleIntEnum; text: string; rowIndex: number };

// DEV_NOTE: Where the issue's reply sits: end = how many lines come before it, anchor = its line (null when it has no
// text, or there is none: nothing answered yet, or the chat ends on an unanswered question)
type AnchorPosition = { end: number; anchor: ChatLine | null };

// DEV_NOTE: What an issue is about, picked from its conversation's messages (M4-6), pure so it is unit-tested on its
// own. The rows are the newest messages up to the rated reply (MessagesDAL.listRecentChatMessages, text only, null
// once purged), so a purged chat has no excerpt and nothing to turn into a test. The anchor is the reply the issue is
// about: the rated reply for a user issue; else the conversation's last reply, unless the chat ends on a question
// nobody answered, which is then the question the issue is about (no reply).
export default class QualityIssuesProvider {
  // DEV_NOTE: How many messages a quality issue reads: a test's messages plus the reply after them
  static readonly MESSAGES_READ_LIMIT = Schemas.EVAL_CASE_MAX_MESSAGES + 1;

  // DEV_NOTE: The list's line for a user issue: the start of the rated reply, cut at QUALITY_ISSUE_EXCERPT_MAX_CHARS
  static ratedReply(text: string | null): string | null {
    const trimmed = text?.trim() ?? "";
    if (trimmed === "") return null;
    return QualityIssuesProvider.cut(trimmed, Schemas.QUALITY_ISSUE_EXCERPT_MAX_CHARS);
  }

  // DEV_NOTE: The detail card's excerpt: the anchor and the user message just before it (either may be missing)
  static excerpt(
    rows: Schemas.ChatMessageTextRow[],
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
  // trailing reply is dropped), newest first while it fits: at most EVAL_CASE_MAX_MESSAGES messages, each cut at
  // EVAL_CASE_MESSAGE_MAX_CHARS, together within QUALITY_TEST_REWRITE_MAX_CHARS (the model restates them in its
  // answer, which has an output cap); the question itself is always kept, cut to fit. The anchor is the reply that
  // went wrong (cut at QUALITY_TEST_REWRITE_REPLY_MAX_CHARS). null = no user question to test.
  static rewriteSource(
    rows: Schemas.ChatMessageTextRow[],
    ratedMessageId: string | null,
    triage: Pick<Schemas.QualityTestRewriteSource, "issueTypeLabel" | "note">,
  ): Schemas.QualityTestRewriteSource | null {
    const lines = QualityIssuesProvider.lines(rows);
    const { end, anchor } = QualityIssuesProvider.anchor(rows, lines, ratedMessageId);
    const before = lines.slice(0, end);
    const lastQuestion = QualityIssuesProvider.lastIndexOf(before, Schemas.MessageRoleIntEnum.User);
    if (lastQuestion === -1) return null;

    const kept: Schemas.EvalCaseMessage[] = [];
    let charsLeft = Schemas.QUALITY_TEST_REWRITE_MAX_CHARS;
    for (let index = lastQuestion; index >= 0; index -= 1) {
      const line = before[index];
      if (!line || kept.length === Schemas.EVAL_CASE_MAX_MESSAGES) break;
      const maxChars =
        kept.length === 0
          ? Math.min(Schemas.EVAL_CASE_MESSAGE_MAX_CHARS, charsLeft)
          : Schemas.EVAL_CASE_MESSAGE_MAX_CHARS;
      const text = QualityIssuesProvider.cut(line.text, maxChars);
      if (text.length > charsLeft) break;
      charsLeft -= text.length;
      kept.unshift({
        role:
          line.role === Schemas.MessageRoleIntEnum.User
            ? Schemas.EvalCaseMessageRoleEnum.User
            : Schemas.EvalCaseMessageRoleEnum.Assistant,
        text,
      });
    }
    return {
      messages: kept,
      reply: anchor
        ? QualityIssuesProvider.cut(anchor.text, Schemas.QUALITY_TEST_REWRITE_REPLY_MAX_CHARS)
        : null,
      issueTypeLabel: triage.issueTypeLabel,
      note: triage.note,
    };
  }

  // DEV_NOTE: A user issue's reply is the rated one, wherever it sits, even with no text (then only what came before it
  // is used, never another reply). Any other issue, or a rated reply missing from the rows, is about the last reply,
  // unless the last line is the user's: a question nobody answered is what the issue is about.
  private static anchor(
    rows: Schemas.ChatMessageTextRow[],
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
    if (lines.at(-1)?.role === Schemas.MessageRoleIntEnum.User) {
      return { end: lines.length, anchor: null };
    }
    const last = QualityIssuesProvider.lastIndexOf(lines, Schemas.MessageRoleIntEnum.Assistant);
    return last === -1
      ? { end: lines.length, anchor: null }
      : { end: last, anchor: lines[last] ?? null };
  }

  // DEV_NOTE: User and assistant messages with text, oldest first (the DAL returns them in id order)
  private static lines(rows: Schemas.ChatMessageTextRow[]): ChatLine[] {
    const lines: ChatLine[] = [];
    for (const [rowIndex, row] of rows.entries()) {
      if (row.role === Schemas.MessageRoleIntEnum.Tool) continue;
      const text = row.text?.trim() ?? "";
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

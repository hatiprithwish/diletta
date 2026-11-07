import * as Schemas from "@app/schemas";

// DEV_NOTE: Your chats as the screen shows them (pure, so the dev gallery and tests draw it from plain data): rows
// grouped by the day of their last activity (Today, Yesterday, Earlier, in the visitor's own time zone), each with
// its line: "Current chat · 10:42" for the chat on screen, "Ongoing · …" for one that can still be picked up,
// "Ended · …" for one that has ended. Times and dates follow the visitor's locale (locale is fixed only in tests).
const GROUP_TODAY = "Today";
const GROUP_YESTERDAY = "Yesterday";
const GROUP_EARLIER = "Earlier";

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayOf(at: Date, now: Date): "today" | "yesterday" | "earlier" {
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day >= today) return "today";
  const yesterday = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return day >= yesterday ? "yesterday" : "earlier";
}

function timeOf(at: Date, locale: string | undefined): string {
  return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function dateOf(at: Date, now: Date, locale: string | undefined): string {
  return at.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

// DEV_NOTE: A row's time: the clock time today and yesterday (its group says which day), else the date
function rowTime(at: Date, now: Date, locale: string | undefined): string {
  return dayOf(at, now) === "earlier" ? dateOf(at, now, locale) : timeOf(at, locale);
}

const TONE_WORD: Record<Schemas.WidgetHistoryToneEnum, string> = {
  [Schemas.WidgetHistoryToneEnum.Current]: "Current chat",
  [Schemas.WidgetHistoryToneEnum.Open]: "Ongoing",
  [Schemas.WidgetHistoryToneEnum.Ended]: "Ended",
};

export function toHistoryView(params: {
  state: Schemas.WidgetHistoryState;
  currentPublicId: string | null;
  now: Date;
  locale?: string;
}): Schemas.WidgetHistoryView {
  const { state, currentPublicId, now, locale } = params;
  if (state.status !== "ready") return state;

  const groups: Schemas.WidgetHistoryGroupView[] = [];
  const labels = { today: GROUP_TODAY, yesterday: GROUP_YESTERDAY, earlier: GROUP_EARLIER };
  for (const item of state.items) {
    const at = new Date(item.lastActivityAt);
    const tone =
      item.publicId === currentPublicId
        ? Schemas.WidgetHistoryToneEnum.Current
        : item.isOpen
          ? Schemas.WidgetHistoryToneEnum.Open
          : Schemas.WidgetHistoryToneEnum.Ended;
    const label = labels[dayOf(at, now)];
    const row = { item, tone, meta: `${TONE_WORD[tone]} · ${rowTime(at, now, locale)}` };
    const last = groups.at(-1);
    if (last?.label === label) {
      last.rows.push(row);
    } else {
      groups.push({ label, rows: [row] });
    }
  }
  return {
    status: "ready",
    groups,
    hasMore: state.items.length < state.totalRecords,
    isLoadingMore: state.isLoadingMore,
    moreFailed: state.moreFailed,
  };
}

// DEV_NOTE: A past chat's line under its title: "Ended · Today, 09:14", "Ended · Yesterday, 16:05", "Ended · 3 Nov"
export function pastChatMeta(
  item: Schemas.WidgetConversationListItem,
  now: Date,
  locale?: string,
): string {
  const at = new Date(item.lastActivityAt);
  const day = dayOf(at, now);
  const when =
    day === "today"
      ? `${GROUP_TODAY}, ${timeOf(at, locale)}`
      : day === "yesterday"
        ? `${GROUP_YESTERDAY}, ${timeOf(at, locale)}`
        : dateOf(at, now, locale);
  return `${item.isOpen ? TONE_WORD[Schemas.WidgetHistoryToneEnum.Open] : TONE_WORD[Schemas.WidgetHistoryToneEnum.Ended]} · ${when}`;
}

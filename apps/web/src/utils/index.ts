import * as Schemas from "@app/schemas";

const USD_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const ONE_DECIMAL_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const PRECISE_USD_FORMAT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});
// DEV_NOTE: How long a download's object URL outlives the click that started it
const DOWNLOAD_REVOKE_DELAY_MS = 1000;
const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const SECONDS_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const LOCAL_MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short" });
// DEV_NOTE: Month names from en-US ("Sep"), day first: en-GB's short month differs between runtimes ("Sept")
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

export default class Utilities {
  static getInitials(name: string): string {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("");
  }

  // Browser only: undefined on the server or when the cookie isn't set
  static getCookie(name: string): string | undefined {
    if (typeof document === "undefined") return undefined;
    const prefix = `${name}=`;
    const entry = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
    return entry === undefined ? undefined : decodeURIComponent(entry.slice(prefix.length));
  }

  // DEV_NOTE: A TanStack Form field's errors as FieldError takes them
  static toFieldErrors(errors: unknown[]) {
    return errors.map((message) => ({ message: String(message) }));
  }

  // ─── Numbers on the Insights pages (M4-3). Money arrives as an exact decimal string; formatting is display only.

  // "$412.80"; a non-zero amount under a cent reads "<$0.01", so a small spend never shows as $0.00
  static formatUsd(value: string): string {
    const amount = Number(value);
    if (amount > 0 && amount < 0.005) return "<$0.01";
    return USD_FORMAT.format(amount);
  }

  // "1,486"
  static formatCount(value: number): string {
    return COUNT_FORMAT.format(value);
  }

  // "14.1 M", "3.2 K", "412"
  static formatTokens(value: number): string {
    if (value >= 1_000_000) return `${ONE_DECIMAL_FORMAT.format(value / 1_000_000)} M`;
    if (value >= 1_000) return `${ONE_DECIMAL_FORMAT.format(value / 1_000)} K`;
    return COUNT_FORMAT.format(value);
  }

  // A 0–1 rate as "91%"; no rate (nothing to divide by) as "—"
  static formatRate(rate: number | null): string {
    return rate === null ? "—" : `${Math.round(rate * 100)}%`;
  }

  // "67.2 h"
  static formatHours(hours: number): string {
    return `${ONE_DECIMAL_FORMAT.format(hours)} h`;
  }

  // A UTC day (YYYY-MM-DD) as "3 Sep"
  static formatDay(day: string): string {
    const date = new Date(`${day}T00:00:00.000Z`);
    return `${date.getUTCDate()} ${MONTH_FORMAT.format(date)}`;
  }

  // "+23%" / "−8%" change from previous to value; null when there is nothing to compare with
  static formatChange(value: number, previousValue: number): string | null {
    if (previousValue === 0) return null;
    const change = Math.round(((value - previousValue) / previousValue) * 100);
    return `${change > 0 ? "+" : change < 0 ? "−" : ""}${Math.abs(change)}%`;
  }

  // The change between two rates in percentage points: "+3 points", "−2 points"; null if either is missing
  static formatPointsChange(rate: number | null, previousRate: number | null): string | null {
    if (rate === null || previousRate === null) return null;
    const points = Math.round(rate * 100) - Math.round(previousRate * 100);
    const sign = points > 0 ? "+" : points < 0 ? "−" : "";
    return `${sign}${Math.abs(points)} ${Math.abs(points) === 1 ? "point" : "points"}`;
  }

  // "just now", "5 minutes ago", "2 hours ago", "3 days ago"
  static formatTimeAgo(iso: string, now: number = Date.now()): string {
    const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }

  // "1 change", "2 changes"
  static plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${Utilities.formatCount(count)} ${count === 1 ? singular : pluralForm}`;
  }

  // ─── Conversations page (M4-4)

  // "$0.041": a conversation or a turn costs cents, so three decimals; a non-zero amount under that reads "<$0.001"
  static formatUsdPrecise(value: string): string {
    const amount = Number(value);
    if (amount > 0 && amount < 0.0005) return "<$0.001";
    return PRECISE_USD_FORMAT.format(amount);
  }

  // A moment in the viewer's time: "14:12" today, "Yesterday", else "3 Sep"
  static formatWhen(iso: string, now: number = Date.now()): string {
    const date = new Date(iso);
    const today = new Date(now);
    const dayStart = (value: Date) =>
      new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const days = Math.round((dayStart(today) - dayStart(date)) / 86_400_000);
    if (days === 0) return TIME_FORMAT.format(date);
    if (days === 1) return "Yesterday";
    return `${date.getDate()} ${LOCAL_MONTH_FORMAT.format(date)}`;
  }

  // "Today 14:10", "Yesterday 09:05", "3 Sep 11:40"
  static formatWhenWithTime(iso: string, now: number = Date.now()): string {
    const when = Utilities.formatWhen(iso, now);
    const time = TIME_FORMAT.format(new Date(iso));
    return when === time ? `Today ${time}` : `${when} ${time}`;
  }

  // DEV_NOTE: A timeline step (M4-5), to the second: steps often land in the same minute. "14:12:03" today, else
  // "Yesterday 14:12:03" / "3 Sep 14:12:03"
  static formatStepTime(iso: string, now: number = Date.now()): string {
    const when = Utilities.formatWhen(iso, now);
    const time = SECONDS_TIME_FORMAT.format(new Date(iso));
    return when === TIME_FORMAT.format(new Date(iso)) ? time : `${when} ${time}`;
  }

  // DEV_NOTE: RFC 4180 CSV: every cell quoted, quotes doubled. A cell a spreadsheet would run as a formula (=, +, -, @,
  // tab, carriage return first) gets a leading apostrophe: titles are what visitors typed.
  static toCsv(rows: string[][]): string {
    const cell = (value: string) => {
      const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    return rows.map((row) => row.map(cell).join(",")).join("\r\n");
  }

  // DEV_NOTE: Browser only: hands the viewer a file to save. The link is attached for the click (older Firefox ignores
  // a detached one) and the URL revoked a moment later (Safari and Firefox start the download asynchronously)
  static downloadFile(fileName: string, content: string, type: string): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
  }

  // DEV_NOTE: A change request's chip tone: verified = success, needs a person or failed = destructive, a mismatch =
  // warning, ended without a change or resolved = neutral, still under way = brand
  static changeRequestTone(
    status: Schemas.ChangeRequestStatusIntEnum,
  ): Schemas.DashboardChipToneEnum {
    switch (status) {
      case Schemas.ChangeRequestStatusIntEnum.Verified:
        return Schemas.DashboardChipToneEnum.Success;
      case Schemas.ChangeRequestStatusIntEnum.NeedsHuman:
      case Schemas.ChangeRequestStatusIntEnum.Failed:
        return Schemas.DashboardChipToneEnum.Destructive;
      case Schemas.ChangeRequestStatusIntEnum.Mismatch:
        return Schemas.DashboardChipToneEnum.Warning;
      case Schemas.ChangeRequestStatusIntEnum.Rejected:
      case Schemas.ChangeRequestStatusIntEnum.Expired:
      case Schemas.ChangeRequestStatusIntEnum.Undone:
      case Schemas.ChangeRequestStatusIntEnum.Resolved:
        return Schemas.DashboardChipToneEnum.Neutral;
      default:
        return Schemas.DashboardChipToneEnum.Brand;
    }
  }
}

const USD_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const ONE_DECIMAL_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
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
}

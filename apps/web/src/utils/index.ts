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
}

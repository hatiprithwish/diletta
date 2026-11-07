import * as Schemas from "@app/schemas";

// DEV_NOTE: The theme variables a host accent replaces (DESIGN.md §7, M7-5). The preset maps its colour utilities
// straight onto these (@theme inline), so setting them on the shadow root's wrapper re-colours every brand fill under
// it, in light and dark. brand-soft is mixed from the fill over the current background.
export const ACCENT_PROPERTIES = [
  "--primary",
  "--primary-foreground",
  "--brand-text",
  "--ring",
  "--brand-soft",
] as const;

export function accentProperties(
  accent: Schemas.WidgetAccent,
): Record<(typeof ACCENT_PROPERTIES)[number], string> {
  const text = accent.text ?? accent.fill;
  return {
    "--primary": accent.fill,
    "--primary-foreground": accent.fillForeground,
    "--brand-text": text,
    "--ring": text,
    "--brand-soft": `color-mix(in oklab, ${accent.fill} 14%, var(--background))`,
  };
}

// DEV_NOTE: The schema checks the characters; the browser decides whether each value is a colour it can draw. Where
// CSS.supports doesn't exist (a test DOM), the schema's check stands.
function isCssColor(value: string): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
  return CSS.supports("color", value);
}

export function parseWidgetAccent(accent: unknown): Schemas.WidgetAccentParseResult {
  const parsed = Schemas.ZWidgetAccent.safeParse(accent);
  if (!parsed.success) {
    return {
      isSuccess: false,
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }
  const values = [parsed.data.fill, parsed.data.fillForeground, parsed.data.text];
  const bad = values.find((value) => value !== undefined && !isCssColor(value));
  if (bad !== undefined) return { isSuccess: false, message: `not a CSS colour: ${bad}` };
  return { isSuccess: true, accent: parsed.data };
}

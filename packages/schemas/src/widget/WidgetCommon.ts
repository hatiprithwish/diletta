import { z } from "zod";
import { ZJwk } from "../widgetAuth/WidgetAuthCommon";

// DEV_NOTE: The chat widget (apps/widget, M2-7). The host page embeds it with a script tag (window.Diletta.init) or as
// a React component (<DilettaWidget />); both take the same options. The widget renders in a Shadow DOM, so host CSS
// can't reach it, and its theme follows the host (light / dark).
export enum WidgetThemeEnum {
  Light = "light",
  Dark = "dark",
}

// DEV_NOTE: One CSS colour from the host (#hex, rgb(), hsl(), oklch(), a named colour…). Only characters a colour
// value can hold, so it can't close the declaration it lands in; the widget also checks it with CSS.supports.
export const ZWidgetCssColor = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[#\w\s(),.%/+-]+$/, "must be a CSS colour");

// DEV_NOTE: The host's brand colour (M7-5), replacing lime in the widget's brand fills: fill = the launcher, send and
// Approve buttons, the welcome icon (--primary); fillForeground = text and icons on that fill (--primary-foreground);
// text = brand as text and the focus ring (--brand-text, --ring; absent = fill). The brand-tinted surface is mixed
// from fill. Diffs and success keep their own colours. The host passes the values for its current light / dark mode
// and calls setAccent when they change; absent = lime.
export const ZWidgetAccent = z.object({
  fill: ZWidgetCssColor,
  fillForeground: ZWidgetCssColor,
  text: ZWidgetCssColor.optional(),
});
export type WidgetAccent = z.infer<typeof ZWidgetAccent>;

// DEV_NOTE: The embed options that are plain data, checked when the widget starts. apiBase is the platform worker's
// origin (https, or http on localhost for development); chatbot is the chatbot's publicId (absent = the company's
// default chatbot); accent is the host's brand colour (absent = lime).
export const ZWidgetEmbedConfig = z.object({
  apiBase: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1"
    );
  }, "apiBase must be https (http only on localhost)"),
  chatbot: z.string().trim().min(1).max(64).optional(),
  theme: z.enum(WidgetThemeEnum).optional(),
  accent: ZWidgetAccent.optional(),
});
export type WidgetEmbedConfig = z.infer<typeof ZWidgetEmbedConfig>;

// DEV_NOTE: getToken asks the host's own backend for a fresh companion JWT (≤ 5 minutes, see ZWidgetJwtClaims). The
// widget calls it before every connect and every bootstrap read and never stores the token. getHostToken (M3-5,
// optional) returns the host user's bearer token for the host's own API (jwt_forward: the chatbot reads and changes
// records as this user): the widget sends it to the Conversation DO on every connect and again when the DO asks
// (token_needed), never stores it, and a host without write tools may leave it out (approvals then can't run).
export type WidgetInitOptions = WidgetEmbedConfig & {
  getToken: () => Promise<string>;
  getHostToken?: () => Promise<string>;
};

// DEV_NOTE: Props of the React export: the same options, all of them reactive (a new theme or accent re-colours it,
// a new chatbot or apiBase starts over)
export type DilettaWidgetProps = WidgetInitOptions;

// DEV_NOTE: What window.Diletta.init returns, and what window.Diletta itself calls on the one embedded widget
export interface WidgetController {
  open: () => void;
  close: () => void;
  setTheme: (theme: WidgetThemeEnum) => void;
  // DEV_NOTE: null goes back to lime; a bad accent throws, like a bad init option
  setAccent: (accent: WidgetAccent | null) => void;
  destroy: () => void;
}

export interface DilettaGlobal extends WidgetController {
  init: (options: WidgetInitOptions) => WidgetController;
}

// DEV_NOTE: The header's status word (DESIGN.md §7)
export enum WidgetStatusEnum {
  Online = "Online",
  Working = "Working",
  Unavailable = "Unavailable",
}

// DEV_NOTE: The widget bundle's size budget (dev plan open question, M2-7): React, the Think chat client, markdown and
// the styles, gzipped. The widget build fails above it.
export const WIDGET_BUNDLE_MAX_GZIP_BYTES = 200 * 1024;

// DEV_NOTE: Development only (apps/widget dev host, `pnpm --filter widget dev`). The dev host signs its own companion
// JWTs with a local ES256 key (apps/widget/.dev/dev-key.json, gitignored, made by `pnpm --filter widget dev:setup`),
// under an issuer of its own that dev:setup registers as a staging company connection. The issuer's JWKS can't be
// fetched (it isn't a real host), so dev:setup seeds it into the local backend's JWKS_CACHE.
export const WIDGET_DEV_PORT = 5174;
export const WIDGET_DEV_ORIGIN = `http://localhost:${WIDGET_DEV_PORT}`;
export const WIDGET_DEV_API_BASE = "http://localhost:8787";

// DEV_NOTE: The dev host's and gallery's sample host accent (?accent=host), per theme: a blue brand like eRegister's
// default, to check the widget re-colours its brand fills in light and dark
export const WIDGET_DEV_ACCENT: Record<WidgetThemeEnum, WidgetAccent> = {
  [WidgetThemeEnum.Light]: {
    fill: "oklch(56% 0.197 262)",
    fillForeground: "oklch(100% 0 0)",
    text: "oklch(49% 0.182 262)",
  },
  [WidgetThemeEnum.Dark]: {
    fill: "oklch(57% 0.153 263)",
    fillForeground: "oklch(100% 0 0)",
    text: "oklch(72% 0.08 265)",
  },
};

// DEV_NOTE: The host user a dev token is signed for (sub) and shown as (name)
export interface WidgetDevUser {
  sub: string;
  name: string;
}

// DEV_NOTE: privateJwk is an EC P-256 private key as WebCrypto exports it (importable as a JsonWebKey as is)
export const ZWidgetDevKey = z.object({
  issuer: z.url(),
  kid: z.string().min(1),
  privateJwk: z.object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string(),
    y: z.string(),
    d: z.string(),
  }),
  publicJwk: ZJwk,
});
export type WidgetDevKey = z.infer<typeof ZWidgetDevKey>;

import widgetCss from "@/styles/widget.css?inline";
import { prepareShadowCss } from "@/shadow/shadowCss";

// DEV_NOTE: The two things the widget must put in the host document, once per page whatever the number of mounts:
// Tailwind's @property rules (ignored inside a shadow root) and the Google Fonts stylesheet (@font-face only
// registers from the document). Both are idempotent and namespaced by id.
const PROPERTIES_STYLE_ID = "diletta-widget-properties";
const FONTS_LINK_ID = "diletta-widget-fonts";
const FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";

const prepared = prepareShadowCss(widgetCss);

export const shadowCss = prepared.shadowCss;

export function ensureDocumentAssets(doc: Document): void {
  if (!doc.getElementById(PROPERTIES_STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = PROPERTIES_STYLE_ID;
    style.textContent = prepared.documentCss;
    doc.head.append(style);
  }
  if (!doc.getElementById(FONTS_LINK_ID)) {
    const link = doc.createElement("link");
    link.id = FONTS_LINK_ID;
    link.rel = "stylesheet";
    link.href = FONTS_URL;
    doc.head.append(link);
  }
}

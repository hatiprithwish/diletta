// DEV_NOTE: Adapts the compiled Tailwind CSS for the widget's shadow root, so the host page can't restyle it and it
// can't restyle the host page:
//   - :root rules (the theme tokens) apply to :host, the shadow root's top;
//   - rem sizes become px, so a host that changes its html font-size can't resize the widget;
//   - :host { all: initial } stops the host's inherited styles (font, colour, line height) at the boundary;
//   - @property rules move out to the document: browsers ignore them inside a shadow root, and Tailwind's shadows,
//     rings and transforms need their registered initial values.
const PROPERTY_RULE = /@property\s+--[\w-]+\s*\{[^}]*\}/g;
const REM = /(-?\d*\.?\d+)rem\b/g;
const ROOT = /:root\b/g;
const REM_PX = 16;

export function prepareShadowCss(css: string): { shadowCss: string; documentCss: string } {
  const documentCss = (css.match(PROPERTY_RULE) ?? []).join("\n");
  const shadowCss = css
    .replace(PROPERTY_RULE, "")
    .replace(ROOT, ":host")
    .replace(REM, (_match, value: string) => `${Number(value) * REM_PX}px`);
  return { shadowCss: `:host{all:initial}\n${shadowCss}`, documentCss };
}

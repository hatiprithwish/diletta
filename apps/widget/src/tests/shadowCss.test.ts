import { describe, it, expect } from "vitest";
import { prepareShadowCss } from "@/shadow/shadowCss";

describe("prepareShadowCss", () => {
  it("moves @property rules to the document and scopes the rest to the shadow root", () => {
    const css = `@property --tw-shadow { syntax: "*"; inherits: false; initial-value: 0 0 #0000; }
:root { --radius: 0.5rem; } .dark { --x: 1; } .p-4 { padding: 1rem; } .m { margin: -0.25rem; }`;
    const { shadowCss, documentCss } = prepareShadowCss(css);
    expect(documentCss).toContain("@property --tw-shadow");
    expect(shadowCss).not.toContain("@property");
    expect(shadowCss.startsWith(":host{all:initial}")).toBe(true);
    expect(shadowCss).toContain(":host { --radius: 8px; }");
    expect(shadowCss).toContain(".p-4 { padding: 16px; }");
    expect(shadowCss).toContain("margin: -4px;");
    expect(shadowCss).not.toContain(":root");
  });
});

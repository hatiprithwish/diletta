import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown } from "@/lib/markdown";

// DEV_NOTE: The widget's markdown subset: what a reply may format, and what it may never smuggle in
const kinds = (text: string) => parseMarkdown(text).map((block) => block.kind);

describe("parseMarkdown", () => {
  it("splits paragraphs, headings, lists and code blocks", () => {
    const text =
      "# Title\nIntro line one\nline two\n\n1. First\n2. Second\n   continued\n\n- a\n- b\n\n```\n<b>x</b>\n```";
    const blocks = parseMarkdown(text);
    expect(kinds(text)).toEqual(["heading", "paragraph", "list", "list", "code"]);
    expect(blocks[1]).toMatchObject({
      children: [{ kind: "text", text: "Intro line one line two" }],
    });
    expect(blocks[2]).toMatchObject({ isOrdered: true, start: 1 });
    const ordered = blocks[2];
    if (ordered?.kind !== "list") throw new Error("Not a list");
    expect(ordered.items[1]?.children).toMatchObject([{ kind: "text", text: "Second continued" }]);
    expect(blocks[4]).toMatchObject({ kind: "code", text: "<b>x</b>" });
  });

  it("keys every node by its position", () => {
    const blocks = parseMarkdown("One **two**\n\nThree");
    expect(blocks.map((block) => block.key)).toEqual(["b0", "b1"]);
    const first = blocks[0];
    if (first?.kind !== "paragraph") throw new Error("Not a paragraph");
    expect(first.children.map((node) => node.key)).toEqual(["b0.0", "b0.1"]);
  });
});

describe("parseInline", () => {
  it("reads code, bold, italic and citation markers", () => {
    expect(parseInline("Open `Settings` then **Fields** and *save* [1, 2].")).toMatchObject([
      { kind: "text", text: "Open " },
      { kind: "code", text: "Settings" },
      { kind: "text", text: " then " },
      { kind: "strong", children: [{ kind: "text", text: "Fields" }] },
      { kind: "text", text: " and " },
      { kind: "em", children: [{ kind: "text", text: "save" }] },
      { kind: "text", text: " " },
      { kind: "citation", n: 1 },
      { kind: "citation", n: 2 },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps http(s) and mailto links, and shows any other target as its text", () => {
    expect(parseInline("[Docs](https://help.example.com)")).toMatchObject([
      { kind: "link", href: "https://help.example.com" },
    ]);
    expect(parseInline("[Mail](mailto:help@example.com)")[0]?.kind).toBe("link");
    expect(parseInline("[Click](javascript:alert(1))")).toMatchObject([
      { kind: "text", text: "Click" },
      { kind: "text", text: ")" },
    ]);
    expect(parseInline("[x](data:text/html,hi)")).toMatchObject([{ kind: "text", text: "x" }]);
  });

  it("leaves raw HTML and snake_case as plain text", () => {
    expect(parseInline('<img src=x onerror="alert(1)">')).toEqual([
      { key: "i.0", kind: "text", text: '<img src=x onerror="alert(1)">' },
    ]);
    expect(parseInline("use field_name_here")).toMatchObject([
      { kind: "text", text: "use field_name_here" },
    ]);
  });
});

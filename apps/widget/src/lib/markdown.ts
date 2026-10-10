import * as Schemas from "@app/schemas";

// DEV_NOTE: The markdown a reply may use, parsed by the widget itself (a small safe subset, chosen over a full
// markdown library for the bundle budget). Pure; the output is data that Markdown.tsx renders as React elements, so
// nothing in a reply ever becomes HTML.
//   Blocks: paragraphs (blank-line separated; lines join with a space), # headings (shown bold), - * + and 1. lists
//   (an indented line continues its item), ``` code blocks.
//   Inline: `code`, **bold** / __bold__, *italic* / _italic_, [text](url) links, [n] / [n, m] citation markers.
// Links keep only http(s) and mailto targets; any other target is shown as its text. Raw HTML is plain text.
const WEB_URL = /^https?:\/\//i;
const MAILTO = /^mailto:/i;
const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const CONTINUATION = /^\s{2,}\S/;
const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(?=\S)([^\n]*?\S)\*\*|(?<!\w)__(?=\S)([^\n]*?\S)__(?!\w)|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(?<!\w)_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g;

// DEV_NOTE: An http(s) address (a source the widget may link to); a reply's links may also be mailto
export const isWebUrl = (url: string | null): url is string => url !== null && WEB_URL.test(url);
const isSafeHref = (href: string) => isWebUrl(href) || MAILTO.test(href);

function parseText(text: string): Schemas.WidgetMarkdownInlineContent[] {
  return Schemas.splitCitationMarkers(text).flatMap(
    (piece): Schemas.WidgetMarkdownInlineContent[] =>
      typeof piece === "string"
        ? [{ kind: "text", text: piece }]
        : piece.map((n) => ({ kind: "citation", n })),
  );
}

export function parseInline(text: string, parentKey = "i"): Schemas.WidgetMarkdownInline[] {
  const nodes: Schemas.WidgetMarkdownInline[] = [];
  const add = (...unkeyed: Schemas.WidgetMarkdownInlineContent[]) => {
    for (const node of unkeyed) {
      nodes.push({ ...node, key: `${parentKey}.${nodes.length}` });
    }
  };
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) add(...parseText(text.slice(last, start)));
    last = start + match[0].length;
    const key = `${parentKey}.${nodes.length}`;

    const [, code, linkText, href, strong, strongUnderscore, em, emUnderscore] = match;
    if (code !== undefined) {
      add({ kind: "code", text: code });
    } else if (linkText !== undefined && href !== undefined) {
      const children = parseInline(linkText, key).filter((node) => node.kind !== "link");
      if (isSafeHref(href)) {
        add({ kind: "link", href, children });
      } else {
        add(...children);
      }
    } else if (strong !== undefined || strongUnderscore !== undefined) {
      add({ kind: "strong", children: parseInline(strong ?? strongUnderscore ?? "", key) });
    } else {
      add({ kind: "em", children: parseInline(em ?? emUnderscore ?? "", key) });
    }
  }
  if (last < text.length) add(...parseText(text.slice(last)));
  return nodes;
}

export function parseMarkdown(text: string): Schemas.WidgetMarkdownBlock[] {
  const blocks: Schemas.WidgetMarkdownBlock[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: Schemas.WidgetMarkdownListDraft | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      const key = `b${blocks.length}`;
      blocks.push({ key, kind: "paragraph", children: parseInline(paragraph.join(" "), key) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const key = `b${blocks.length}`;
      blocks.push({
        key,
        kind: "list",
        isOrdered: list.isOrdered,
        start: list.start,
        items: list.items.map((item, itemIndex) => {
          const itemKey = `${key}.${itemIndex}`;
          return { key: itemKey, children: parseInline(item, itemKey) };
        }),
      });
      list = null;
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";

    if (FENCE.test(line)) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index++;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index++;
      }
      blocks.push({ key: `b${blocks.length}`, kind: "code", text: code.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const key = `b${blocks.length}`;
      blocks.push({ key, kind: "heading", children: parseInline(heading[1] ?? "", key) });
    } else if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      if (!list || list.isOrdered !== isOrdered) {
        flushList();
        list = { isOrdered, start: ordered ? Number(ordered[1]) : 1, items: [] };
      }
      list.items.push((ordered ? ordered[2] : unordered?.[1]) ?? "");
    } else if (list && CONTINUATION.test(line)) {
      const lastItem = list.items.length - 1;
      list.items[lastItem] = `${list.items[lastItem] ?? ""} ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

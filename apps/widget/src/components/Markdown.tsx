import { Fragment } from "react";
import type { ReactNode } from "react";
import { cn } from "@app/ui/lib/utils";
import type * as Schemas from "@app/schemas";
import { parseMarkdown } from "@/lib/markdown";

// DEV_NOTE: A reply's text, from the widget's own safe markdown parser (lib/markdown.ts): every node becomes a React
// element or escaped text, never HTML. Links open in a new tab with no referrer; [n] markers are citation chips
// matching the Sources list. While the reply streams, a caret follows its last block.
const CARET = "inline-block h-3.75 w-1.75 rounded-widget-caret bg-brand-text align-[-2px]";
const CARET_AFTER_LAST =
  "[&>:last-child]:after:ml-0.5 [&>:last-child]:after:inline-block [&>:last-child]:after:h-3.75 [&>:last-child]:after:w-1.75 [&>:last-child]:after:rounded-widget-caret [&>:last-child]:after:bg-brand-text [&>:last-child]:after:align-[-2px] [&>:last-child]:after:content-['']";

function renderInline(nodes: Schemas.WidgetMarkdownInline[]): ReactNode {
  return nodes.map((node) => <Fragment key={node.key}>{renderNode(node)}</Fragment>);
}

function renderNode(node: Schemas.WidgetMarkdownInline): ReactNode {
  switch (node.kind) {
    case "text":
      return node.text;
    case "strong":
      return <strong className="font-semibold">{renderInline(node.children)}</strong>;
    case "em":
      return <em>{renderInline(node.children)}</em>;
    case "code":
      return (
        <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-mono-value">
          {node.text}
        </code>
      );
    case "link":
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-brand-text underline underline-offset-2"
        >
          {renderInline(node.children)}
        </a>
      );
    case "citation":
      return (
        <span
          aria-label={`Source ${node.n}`}
          className="ml-0.75 inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-muted px-0.75 align-[1px] text-widget-chip font-semibold text-subtle-foreground"
        >
          {node.n}
        </span>
      );
  }
}

function renderBlock(block: Schemas.WidgetMarkdownBlock): ReactNode {
  return <Fragment key={block.key}>{renderBlockContent(block)}</Fragment>;
}

function renderBlockContent(block: Schemas.WidgetMarkdownBlock): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return <p>{renderInline(block.children)}</p>;
    case "heading":
      return <p className="font-semibold">{renderInline(block.children)}</p>;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-mono-value">
          {block.text}
        </pre>
      );
    case "list": {
      const items = block.items.map((item) => (
        <li key={item.key}>{renderInline(item.children)}</li>
      ));
      return block.isOrdered ? (
        <ol start={block.start} className="flex list-decimal flex-col gap-1.5 pl-4.5">
          {items}
        </ol>
      ) : (
        <ul className="flex list-disc flex-col gap-1.5 pl-4.5">{items}</ul>
      );
    }
  }
}

export default function Markdown({ text, isStreaming }: Schemas.WidgetMarkdownProps) {
  if (!text) {
    return isStreaming ? <span aria-hidden className={CARET} /> : null;
  }
  return (
    <div className={cn("flex flex-col gap-3 break-words", isStreaming && CARET_AFTER_LAST)}>
      {parseMarkdown(text).map(renderBlock)}
    </div>
  );
}

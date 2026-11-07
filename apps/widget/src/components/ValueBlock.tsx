import { cn } from "@app/ui/lib/utils";
import { isCodeValue } from "@/lib/changeRequestView";

// DEV_NOTE: A long or multi-line host value (HTML, JS, JSON, a paragraph) as a block of its own: line breaks and
// indentation kept, wrapped at the block's edge, scrolling past a height cap instead of growing the card.
export default function ValueBlock({
  text,
  as: Tag = "div",
  className,
}: {
  text: string;
  as?: "div" | "del" | "ins";
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        "block max-h-48 min-w-0 overflow-auto rounded-md px-2 py-1.5 no-underline",
        className,
      )}
    >
      <div
        className={cn(
          "break-words whitespace-pre-wrap",
          isCodeValue(text) && "font-mono text-mono-value",
        )}
      >
        {text}
      </div>
    </Tag>
  );
}

import { ArrowSquareOut, FileText } from "@phosphor-icons/react";
import type * as Schemas from "@app/schemas";

// DEV_NOTE: The sources a reply's [n] markers cite (host-Main), numbered like the markers. A source with a web address
// opens it in a new tab; an uploaded file has none and is listed only.
const isWebUrl = (url: string | null): url is string => url !== null && /^https?:\/\//i.test(url);

export default function Sources({ citations }: Schemas.WidgetSourcesProps) {
  if (citations.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" aria-label="Sources">
      {citations.map((citation) => {
        const title = citation.title ?? "Untitled document";
        const content = (
          <>
            <span className="text-[11px] font-semibold text-muted-foreground">{citation.n}</span>
            <span className="grow truncate text-[13px]">{title}</span>
            <span className="text-muted-foreground">
              {isWebUrl(citation.sourceUrl) ? (
                <ArrowSquareOut className="size-3.5" />
              ) : (
                <FileText className="size-3.5" />
              )}
            </span>
          </>
        );
        const className =
          "flex h-9.5 items-center gap-2.5 rounded-lg border border-border px-2.5 text-foreground";
        return isWebUrl(citation.sourceUrl) ? (
          <a
            key={citation.n}
            href={citation.sourceUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={`${className} transition-colors hover:bg-muted`}
          >
            {content}
          </a>
        ) : (
          <div key={citation.n} className={className}>
            {content}
          </div>
        );
      })}
    </div>
  );
}

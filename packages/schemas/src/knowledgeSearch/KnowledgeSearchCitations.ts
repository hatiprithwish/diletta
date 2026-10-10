import type { KnowledgeCitation } from "./KnowledgeSearchCommon";

// DEV_NOTE: The [n] citation markers a reply writes (M2-6), shared by the backend (the read model keeps the citations a
// reply uses) and the widget (chips in the text, its Sources list), so both read the same markers. Pure.
// A marker is [n] or [n, m], not right after a word character or a bracket (items[1], a[1][2]) and not followed by "("
// (a markdown link [1](https://…)). Code spans and blocks never hold markers.
const CITATION_MARKER = /(?<![\w\]])\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

const markerNumbers = (marker: string): number[] =>
  marker.split(",").map((number) => Number(number.trim()));

// DEV_NOTE: A plain citation object, so nothing else a caller's object carries (an excerpt, say) rides along
export const toCitation = (citation: KnowledgeCitation): KnowledgeCitation => ({
  n: citation.n,
  documentPublicId: citation.documentPublicId,
  title: citation.title,
  sourceUrl: citation.sourceUrl,
});

// DEV_NOTE: The citations the text cites, once each, in number order. A number with no citation behind it (a made-up
// marker) is ignored. Returns plain citation objects (toCitation).
export const citedBy = (text: string, citations: KnowledgeCitation[]): KnowledgeCitation[] => {
  const cited = new Set<number>();
  for (const marker of text.replace(CODE, " ").matchAll(CITATION_MARKER)) {
    for (const number of markerNumbers(marker[1] ?? "")) {
      cited.add(number);
    }
  }
  const byNumber = new Map(citations.map((citation) => [citation.n, citation]));
  return [...cited]
    .sort((a, b) => a - b)
    .flatMap((n) => {
      const citation = byNumber.get(n);
      return citation ? [toCitation(citation)] : [];
    });
};

// DEV_NOTE: The text cut at its markers: plain text pieces and the numbers each marker cites, in order (no code
// handling: the caller passes text outside code). The widget draws the numbers as citation chips.
export const splitCitationMarkers = (text: string): (string | number[])[] => {
  const pieces: (string | number[])[] = [];
  let last = 0;
  for (const marker of text.matchAll(CITATION_MARKER)) {
    const start = marker.index ?? 0;
    if (start > last) pieces.push(text.slice(last, start));
    pieces.push(markerNumbers(marker[1] ?? ""));
    last = start + marker[0].length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
};

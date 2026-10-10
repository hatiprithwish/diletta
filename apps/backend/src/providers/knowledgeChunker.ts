import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";

// DEV_NOTE: An ATX heading: 1–6 #, a space, the text, and optional closing #s that must follow a space (so "C#" keeps
// its #)
const HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
// DEV_NOTE: A code fence opens with 3+ backticks or tildes and closes only with the same character, at least as long
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_PATH_SEPARATOR = " > ";

interface Section {
  level: number;
  heading: string | null;
  headingPath: string | null;
  paragraphs: string[];
}

interface Fence {
  char: string;
  length: number;
}

// DEV_NOTE: Pure text handling for knowledge ingestion (M2-5): normalize the markdown a page or upload converts to,
// hash it (content_hash: an unchanged text skips chunking and embedding), take its title, and cut it into chunks.
// No env, no I/O; unit-tested in knowledgeChunker.test.ts.
export default class KnowledgeChunkerProvider {
  // DEV_NOTE: The text that is hashed and chunked. Only whitespace that never changes meaning is folded, so the same
  // page always hashes the same while any real edit changes the hash. NUL characters are dropped: Postgres text
  // can't hold them (a UTF-16 file or extracted PDF text would otherwise fail on every sync).
  static normalizeText(text: string): string {
    return text
      .replaceAll("\u0000", "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // DEV_NOTE: knowledge_documents.content_hash: the pipeline version, then sha256 (hex) of the normalized text (not of
  // the bytes, so a page whose markup changes but whose text doesn't is still skipped). Bumping
  // KNOWLEDGE_PIPELINE_VERSION changes every hash, so documents indexed by an older chunker or model are redone.
  static async contentHash(normalizedText: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedText));
    return `${Schemas.KNOWLEDGE_PIPELINE_VERSION}:${KnowledgeChunkerProvider.toHex(new Uint8Array(digest))}`;
  }

  // DEV_NOTE: files.sha256: the stored bytes
  static async hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return KnowledgeChunkerProvider.toHex(new Uint8Array(digest));
  }

  // DEV_NOTE: The title shown in citations: the first level-1 heading, else the first heading of any level, else null
  // (the caller falls back to the URL or file name)
  static extractTitle(normalizedText: string): string | null {
    let firstHeading: string | null = null;
    let fence: Fence | null = null;
    for (const line of normalizedText.split("\n")) {
      const fenceState = KnowledgeChunkerProvider.nextFence(line, fence);
      if (fenceState.isFenceLine) {
        fence = fenceState.fence;
        continue;
      }
      if (fence) continue;
      const match = HEADING_PATTERN.exec(line);
      if (!match) continue;
      const text = KnowledgeChunkerProvider.cleanHeading(match[2] ?? "");
      if (!text) continue;
      const title = text.slice(0, Constants.KNOWLEDGE_TITLE_MAX_CHARS);
      if (match[1] === "#") return title;
      firstHeading ??= title;
    }
    return firstHeading;
  }

  // DEV_NOTE: Sections at markdown headings (outside code fences); each chunk carries the headings above it as its
  // heading_path. Paragraphs are packed up to KNOWLEDGE_CHUNK_TARGET_CHARS; the next chunk of the same section starts
  // with the last KNOWLEDGE_CHUNK_OVERLAP_CHARS of the previous one when that still fits, so an answer that spans the
  // cut is still found. A paragraph longer than the target is split at whitespace. A heading with no text under it
  // (and no deeper heading) is kept as a chunk of its own, so text that exists only in headings is still searchable.
  static chunk(normalizedText: string): Schemas.ChunkedKnowledgeDocument {
    const target = Constants.KNOWLEDGE_CHUNK_TARGET_CHARS;
    const chunks: Schemas.KnowledgeChunkDraft[] = [];

    for (const section of KnowledgeChunkerProvider.toSections(normalizedText)) {
      const pieces = section.paragraphs.flatMap((paragraph) =>
        KnowledgeChunkerProvider.splitLong(
          paragraph,
          target - Constants.KNOWLEDGE_CHUNK_OVERLAP_CHARS,
        ),
      );
      let current = "";
      let previous: string | null = null;

      const flush = () => {
        const text = current.trim();
        if (!text) return;
        chunks.push({ chunkIndex: chunks.length, headingPath: section.headingPath, text });
        previous = text;
        current = "";
      };

      for (const piece of pieces) {
        const candidate = current ? `${current}\n\n${piece}` : piece;
        if (current && candidate.length > target) {
          flush();
          const overlap = previous
            ? KnowledgeChunkerProvider.tail(previous, Constants.KNOWLEDGE_CHUNK_OVERLAP_CHARS)
            : "";
          const withOverlap = overlap ? `${overlap}\n\n${piece}` : piece;
          current = withOverlap.length <= target ? withOverlap : piece;
        } else {
          current = candidate;
        }
      }
      flush();

      if (chunks.length > Constants.KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT) {
        chunks.length = Constants.KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT;
        return { chunks, isTruncated: true };
      }
    }

    return { chunks, isTruncated: false };
  }

  // DEV_NOTE: What is embedded for a chunk: its heading path above its text, so a chunk deep in a page still carries
  // what it is about. Also what the search reranker scores (KnowledgeSearchRepo), so both see a chunk the same way.
  static embeddingText(chunk: Pick<Schemas.KnowledgeChunkDraft, "headingPath" | "text">): string {
    return chunk.headingPath ? `${chunk.headingPath}\n\n${chunk.text}` : chunk.text;
  }

  private static toSections(normalizedText: string): Section[] {
    const sections: Section[] = [];
    const headings: { level: number; text: string }[] = [];
    let section: Section = { level: 0, heading: null, headingPath: null, paragraphs: [] };
    let paragraph: string[] = [];
    let fence: Fence | null = null;

    const endParagraph = () => {
      const text = paragraph.join("\n").trim();
      if (text) section.paragraphs.push(text);
      paragraph = [];
    };
    // DEV_NOTE: A section with no text is kept only when it is a leaf (the next heading isn't deeper): its heading is
    // its text. A parent heading with nothing of its own is already in its children's heading paths.
    const endSection = (nextLevel: number) => {
      endParagraph();
      if (section.paragraphs.length === 0 && section.heading && nextLevel <= section.level) {
        section.paragraphs.push(section.heading);
      }
      if (section.paragraphs.length > 0) sections.push(section);
    };

    for (const line of normalizedText.split("\n")) {
      const fenceState = KnowledgeChunkerProvider.nextFence(line, fence);
      if (fenceState.isFenceLine) {
        fence = fenceState.fence;
        paragraph.push(line);
        continue;
      }
      const match = fence ? null : HEADING_PATTERN.exec(line);
      if (match) {
        const level = match[1]?.length ?? 1;
        endSection(level);
        const text = KnowledgeChunkerProvider.cleanHeading(match[2] ?? "").slice(
          0,
          Constants.KNOWLEDGE_HEADING_MAX_CHARS,
        );
        while (headings.length > 0 && (headings[headings.length - 1]?.level ?? 0) >= level) {
          headings.pop();
        }
        if (text) headings.push({ level, text });
        const path = headings.map((heading) => heading.text).join(HEADING_PATH_SEPARATOR);
        section = {
          level,
          heading: text || null,
          headingPath: path ? path.slice(0, Constants.KNOWLEDGE_HEADING_PATH_MAX_CHARS) : null,
          paragraphs: [],
        };
        continue;
      }
      if (!fence && line.trim() === "") {
        endParagraph();
        continue;
      }
      paragraph.push(line);
    }
    endSection(0);

    return sections;
  }

  // DEV_NOTE: Whether a line opens or closes a fence, and the fence state after it. Only the opening character, at
  // least as many times, closes it, so a ~~~ inside a ``` block stays code.
  private static nextFence(
    line: string,
    fence: Fence | null,
  ): { isFenceLine: boolean; fence: Fence | null } {
    const match = FENCE_PATTERN.exec(line);
    if (!match) return { isFenceLine: false, fence };
    const marker = match[1] ?? "";
    const char = marker.charAt(0);
    if (!fence) return { isFenceLine: true, fence: { char, length: marker.length } };
    const isClosing =
      char === fence.char && marker.length >= fence.length && line.trim() === marker;
    return isClosing ? { isFenceLine: true, fence: null } : { isFenceLine: false, fence };
  }

  // DEV_NOTE: Markdown emphasis and links in a heading are noise in a citation title or heading path
  private static cleanHeading(text: string): string {
    return text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
  }

  private static splitLong(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];
    const pieces: string[] = [];
    let rest = text;
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars);
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
      const at = cut > maxChars / 2 ? cut : maxChars;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
    return pieces;
  }

  // DEV_NOTE: The last maxChars of a chunk, started at a word boundary
  private static tail(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const slice = text.slice(text.length - maxChars);
    const space = slice.indexOf(" ");
    return (space >= 0 ? slice.slice(space + 1) : slice).trim();
  }

  private static toHex(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

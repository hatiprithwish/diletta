import type * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_PATTERN = /^\s*(```|~~~)/;
const HEADING_PATH_SEPARATOR = " > ";

interface Section {
  headingPath: string | null;
  paragraphs: string[];
}

// DEV_NOTE: Pure text handling for knowledge ingestion (M2-5): normalize the markdown a page or upload converts to,
// hash it (content_hash: an unchanged text skips chunking and embedding), take its title, and cut it into chunks.
// No env, no I/O; unit-tested in knowledgeChunker.test.ts.
export default class KnowledgeChunkerProvider {
  // DEV_NOTE: The text that is hashed and chunked. Only whitespace that never changes meaning is folded, so the same
  // page always hashes the same while any real edit changes the hash.
  static normalizeText(text: string): string {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // DEV_NOTE: knowledge_documents.content_hash: sha256 (hex) of the normalized text, not of the bytes, so a page whose
  // markup changes but whose text doesn't is still skipped
  static async hashText(normalizedText: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedText));
    return KnowledgeChunkerProvider.toHex(new Uint8Array(digest));
  }

  static async hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return KnowledgeChunkerProvider.toHex(new Uint8Array(digest));
  }

  // DEV_NOTE: The title shown in citations: the first level-1 heading, else the first heading of any level, else null
  // (the caller falls back to the URL or file name)
  static extractTitle(normalizedText: string): string | null {
    let firstHeading: string | null = null;
    let isInFence = false;
    for (const line of normalizedText.split("\n")) {
      if (FENCE_PATTERN.test(line)) {
        isInFence = !isInFence;
        continue;
      }
      if (isInFence) continue;
      const match = HEADING_PATTERN.exec(line);
      if (!match) continue;
      const text = KnowledgeChunkerProvider.cleanHeading(match[2] ?? "");
      if (!text) continue;
      if (match[1] === "#") return text.slice(0, Constants.KNOWLEDGE_TITLE_MAX_CHARS);
      firstHeading ??= text;
    }
    return firstHeading ? firstHeading.slice(0, Constants.KNOWLEDGE_TITLE_MAX_CHARS) : null;
  }

  // DEV_NOTE: Sections at markdown headings (outside code fences); each chunk carries the headings above it as its
  // heading_path. Paragraphs are packed up to KNOWLEDGE_CHUNK_TARGET_CHARS; the next chunk of the same section starts
  // with the last KNOWLEDGE_CHUNK_OVERLAP_CHARS of the previous one, so an answer that spans the cut is still found.
  // A paragraph longer than the target is split at whitespace.
  static chunk(normalizedText: string): Schemas.ChunkedKnowledgeDocument {
    const chunks: Schemas.KnowledgeChunkDraft[] = [];
    let isTruncated = false;

    for (const section of KnowledgeChunkerProvider.toSections(normalizedText)) {
      const pieces = section.paragraphs.flatMap((paragraph) =>
        KnowledgeChunkerProvider.splitLong(paragraph, Constants.KNOWLEDGE_CHUNK_TARGET_CHARS),
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
        if (current && candidate.length > Constants.KNOWLEDGE_CHUNK_TARGET_CHARS) {
          flush();
          const overlap = previous
            ? KnowledgeChunkerProvider.tail(previous, Constants.KNOWLEDGE_CHUNK_OVERLAP_CHARS)
            : "";
          current = overlap ? `${overlap}\n\n${piece}` : piece;
        } else {
          current = candidate;
        }
      }
      flush();

      if (chunks.length > Constants.KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT) {
        isTruncated = true;
        chunks.length = Constants.KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT;
        break;
      }
    }

    return { chunks, isTruncated };
  }

  // DEV_NOTE: What is embedded for a chunk: its heading path above its text, so a chunk deep in a page still carries
  // what it is about
  static embeddingText(chunk: Schemas.KnowledgeChunkDraft): string {
    return chunk.headingPath ? `${chunk.headingPath}\n\n${chunk.text}` : chunk.text;
  }

  private static toSections(normalizedText: string): Section[] {
    const sections: Section[] = [];
    const headings: { level: number; text: string }[] = [];
    let section: Section = { headingPath: null, paragraphs: [] };
    let paragraph: string[] = [];
    let isInFence = false;

    const endParagraph = () => {
      const text = paragraph.join("\n").trim();
      if (text) section.paragraphs.push(text);
      paragraph = [];
    };

    for (const line of normalizedText.split("\n")) {
      if (FENCE_PATTERN.test(line)) {
        isInFence = !isInFence;
        paragraph.push(line);
        continue;
      }
      const match = isInFence ? null : HEADING_PATTERN.exec(line);
      if (match) {
        endParagraph();
        if (section.paragraphs.length > 0) sections.push(section);
        const level = match[1]?.length ?? 1;
        const text = KnowledgeChunkerProvider.cleanHeading(match[2] ?? "");
        while (headings.length > 0 && (headings[headings.length - 1]?.level ?? 0) >= level) {
          headings.pop();
        }
        if (text) headings.push({ level, text });
        section = {
          headingPath:
            headings.length > 0 ? headings.map((h) => h.text).join(HEADING_PATH_SEPARATOR) : null,
          paragraphs: [],
        };
        continue;
      }
      if (!isInFence && line.trim() === "") {
        endParagraph();
        continue;
      }
      paragraph.push(line);
    }
    endParagraph();
    if (section.paragraphs.length > 0) sections.push(section);

    return sections;
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

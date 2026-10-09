import * as Schemas from "@app/schemas";
import AppLogger from "@/providers/logger";

// DEV_NOTE: MIME types read as UTF-8 text as they are; everything in CONVERTED_MIME_EXTENSION goes through Workers AI
// toMarkdown, named with its extension (toMarkdown picks the converter from it). Anything else is unsupported.
const TEXT_MIME_TYPES: ReadonlySet<string> = new Set(["text/plain", "text/markdown"]);
const CONVERTED_MIME_EXTENSION: Readonly<Record<string, string>> = {
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// DEV_NOTE: Magic bytes of the binary upload formats: a PDF starts with %PDF-, a DOCX is a zip (PK\x03\x04)
const MAGIC_BYTES: Readonly<Record<string, number[]>> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    0x50, 0x4b, 0x03, 0x04,
  ],
};

// DEV_NOTE: A document's bytes → markdown text (M2-5). Workers AI toMarkdown (HTML, PDF, DOCX) is the only env.AI
// call besides embeddings (pattern rule 3.10): it runs no model on these formats (images would, so none is sent).
// Returns { isSuccess, message } and never throws.
export default class KnowledgeExtractProvider {
  static isSupportedMime(mime: string): boolean {
    return TEXT_MIME_TYPES.has(mime) || Object.hasOwn(CONVERTED_MIME_EXTENSION, mime);
  }

  // DEV_NOTE: Pure: whether an upload's bytes are what its type claims. PDF and DOCX must start with their magic bytes;
  // text formats are anything (they're decoded, and NUL characters dropped, later).
  static matchesType(bytes: Uint8Array, mime: string): boolean {
    const magic = Object.hasOwn(MAGIC_BYTES, mime) ? MAGIC_BYTES[mime] : undefined;
    return !magic || magic.every((byte, index) => bytes[index] === byte);
  }

  // DEV_NOTE: Pure: text bytes → string. A byte-order mark decides first (UTF-8, UTF-16 LE / BE), then the response's
  // charset, else UTF-8. An unknown charset label falls back to UTF-8 instead of failing the document.
  static decodeText(bytes: Uint8Array, charset: string | null): string {
    const label =
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? "utf-8"
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? "utf-16le"
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? "utf-16be"
            : (charset ?? "utf-8");
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }

  static async toText(
    env: Env,
    params: { bytes: Uint8Array<ArrayBuffer>; mime: string; charset: string | null },
  ): Promise<Schemas.KnowledgeTextResponse> {
    const response: Schemas.KnowledgeTextResponse = { isSuccess: false };

    if (TEXT_MIME_TYPES.has(params.mime)) {
      response.isSuccess = true;
      response.message = "Text read successfully";
      response.text = KnowledgeExtractProvider.decodeText(params.bytes, params.charset);
      return response;
    }

    const extension = Object.hasOwn(CONVERTED_MIME_EXTENSION, params.mime)
      ? CONVERTED_MIME_EXTENSION[params.mime]
      : undefined;
    if (!extension) {
      response.message = `Unsupported document type: ${params.mime || "none"}`;
      return response;
    }

    try {
      const converted = await env.AI.toMarkdown({
        name: `document.${extension}`,
        blob: new Blob([params.bytes], { type: params.mime }),
      });
      if (converted.format === "error") {
        const message = "Document could not be converted";
        AppLogger.warn({
          category: Schemas.LogCategory.Knowledge,
          action: Schemas.LogAction.ExtractKnowledgeText,
          message,
          metadata: { mime: params.mime, error: converted.error },
        });
        response.message = message;
        return response;
      }

      response.isSuccess = true;
      response.message = "Document converted successfully";
      response.text = converted.data;
    } catch (error) {
      const message = "Unknown error in converting document";
      AppLogger.error({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.ExtractKnowledgeText,
        message,
        error,
        metadata: { mime: params.mime },
      });
      response.message = message;
    }

    return response;
  }
}

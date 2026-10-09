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

// DEV_NOTE: A document's bytes → markdown text (M2-5). Workers AI toMarkdown (HTML, PDF, DOCX) is the only env.AI
// call besides embeddings (pattern rule 3.10): it runs no model on these formats (images would, so none is sent).
// Returns { isSuccess, message } and never throws.
export default class KnowledgeExtractProvider {
  static isSupportedMime(mime: string): boolean {
    return TEXT_MIME_TYPES.has(mime) || Object.hasOwn(CONVERTED_MIME_EXTENSION, mime);
  }

  static async toText(
    env: Env,
    params: { bytes: Uint8Array<ArrayBuffer>; mime: string },
  ): Promise<Schemas.KnowledgeTextResponse> {
    const response: Schemas.KnowledgeTextResponse = { isSuccess: false };

    if (TEXT_MIME_TYPES.has(params.mime)) {
      response.isSuccess = true;
      response.message = "Text read successfully";
      response.text = new TextDecoder().decode(params.bytes);
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

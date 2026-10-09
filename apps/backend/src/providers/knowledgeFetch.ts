import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import AppLogger from "@/providers/logger";

const LOC_PATTERN = /<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi;
const SITEMAP_INDEX_PATTERN = /<sitemapindex[\s>]/i;
const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

// DEV_NOTE: Fetches web knowledge (M2-5): pages and sitemaps of a company's sitemap / url source. Only http(s) URLs
// on the source's own host are crawled; every fetch is capped in time (KNOWLEDGE_FETCH_TIMEOUT_MS) and size (read as a
// stream, cut off at the cap), so a slow or huge response can't hold a sync step. Returns { isSuccess, message } and
// never throws. Fetched text is untrusted content: it is stored and searched, never followed as instructions.
export default class KnowledgeFetchProvider {
  static async fetchDocument(
    url: string,
    maxBytes: number,
  ): Promise<Schemas.KnowledgeFetchResponse> {
    const response: Schemas.KnowledgeFetchResponse = { isSuccess: false };

    if (!KnowledgeFetchProvider.isCrawlableUrl(url)) {
      response.message = "URL is not crawlable";
      return response;
    }

    try {
      const fetched = await fetch(url, {
        headers: {
          "User-Agent": Constants.KNOWLEDGE_FETCH_USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml,text/xml,application/pdf,text/plain,text/markdown;q=0.9,*/*;q=0.5",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(Constants.KNOWLEDGE_FETCH_TIMEOUT_MS),
      });

      if (!fetched.ok) {
        await fetched.body?.cancel();
        response.message = `Fetch answered ${fetched.status}`;
        return response;
      }

      const declaredLength = Number(fetched.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await fetched.body?.cancel();
        response.message = "Response is too large";
        return response;
      }

      const bytes = await KnowledgeFetchProvider.readCapped(fetched.body, maxBytes);
      if (!bytes) {
        response.message = "Response is too large";
        return response;
      }

      response.isSuccess = true;
      response.message = "Document fetched successfully";
      response.bytes = bytes;
      response.mime =
        fetched.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      response.finalUrl = fetched.url || url;
    } catch (error) {
      const message = "Fetch failed";
      AppLogger.warn({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.FetchKnowledgePage,
        message,
        // DEV_NOTE: A dead or slow site is expected, so warn with the error's name (TimeoutError, TypeError) only
        metadata: { url, reason: error instanceof Error ? error.name : "unknown" },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every page URL of a sitemap, following a sitemap index down to KNOWLEDGE_SITEMAP_MAX_DEPTH levels.
  // Kept: http(s) on the sitemap's own host, fragment removed, each once, at most KNOWLEDGE_MAX_ITEMS_PER_SYNC. The
  // root sitemap must load; a nested one that fails is skipped (logged), so one broken child doesn't fail the sync.
  static async listSitemapUrls(sitemapUrl: string): Promise<Schemas.SitemapUrlsResponse> {
    const response: Schemas.SitemapUrlsResponse = { isSuccess: false };
    const host = KnowledgeFetchProvider.hostOf(sitemapUrl);
    if (!host || !KnowledgeFetchProvider.isCrawlableUrl(sitemapUrl)) {
      response.message = "Sitemap URL is not crawlable";
      return response;
    }

    const urls = new Set<string>();
    const seenSitemaps = new Set<string>();
    let level = [sitemapUrl];

    for (
      let depth = 0;
      depth <= Constants.KNOWLEDGE_SITEMAP_MAX_DEPTH && level.length > 0;
      depth++
    ) {
      const next: string[] = [];
      for (const url of level) {
        if (urls.size >= Constants.KNOWLEDGE_MAX_ITEMS_PER_SYNC) break;
        if (seenSitemaps.has(url)) continue;
        seenSitemaps.add(url);

        const sitemap = await KnowledgeFetchProvider.fetchSitemap(url);
        if (!sitemap.isSuccess || !sitemap.parsed) {
          if (depth === 0) {
            response.message = sitemap.message ?? "Sitemap could not be read";
            return response;
          }
          AppLogger.warn({
            category: Schemas.LogCategory.Knowledge,
            action: Schemas.LogAction.ListSitemapUrls,
            message: "Nested sitemap skipped",
            metadata: { url, reason: sitemap.message ?? null },
          });
          continue;
        }

        for (const loc of sitemap.parsed.locs) {
          const normalized = KnowledgeFetchProvider.normalizeUrl(loc, host);
          if (!normalized) continue;
          if (sitemap.parsed.isIndex) {
            next.push(normalized);
          } else if (urls.size < Constants.KNOWLEDGE_MAX_ITEMS_PER_SYNC) {
            urls.add(normalized);
          }
        }
      }
      level = next;
    }

    response.isSuccess = true;
    response.message = "Sitemap URLs listed successfully";
    response.urls = [...urls];
    return response;
  }

  // DEV_NOTE: Pure: a sitemap's <loc> values (CDATA and XML entities decoded) and whether it is an index of sitemaps
  static parseSitemap(xml: string): Schemas.ParsedSitemap {
    const locs: string[] = [];
    for (const match of xml.matchAll(LOC_PATTERN)) {
      const loc = (match[1] ?? "").replace(
        /&(amp|lt|gt|quot|apos);/g,
        (entity) => XML_ENTITIES[entity] ?? entity,
      );
      if (loc) locs.push(loc.trim());
    }
    return { isIndex: SITEMAP_INDEX_PATTERN.test(xml), locs };
  }

  // DEV_NOTE: Pure: http(s) with no credentials in it. Hostnames were checked as public domains when the source was
  // created (ZKnowledgeSourceUrl); page URLs come from that host only (normalizeUrl).
  static isCrawlableUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }

  // DEV_NOTE: Pure: the URL a page is stored under (knowledge_documents.source_url), or null when it is off the host
  // or not crawlable. The fragment is dropped (same page); the query is kept (it can select different content).
  static normalizeUrl(url: string, host: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.host !== host || !KnowledgeFetchProvider.isCrawlableUrl(parsed.href)) return null;
      parsed.hash = "";
      return parsed.href;
    } catch {
      return null;
    }
  }

  static hostOf(url: string): string | null {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  private static async fetchSitemap(url: string): Promise<Schemas.ParsedSitemapResponse> {
    const fetched = await KnowledgeFetchProvider.fetchDocument(
      url,
      Constants.KNOWLEDGE_SITEMAP_MAX_BYTES,
    );
    if (!fetched.isSuccess || !fetched.bytes) {
      return { isSuccess: false, message: fetched.message };
    }

    // DEV_NOTE: sitemap.xml.gz is served as gzip bytes (not Content-Encoding), so it is unpacked here, capped again
    const isGzip =
      fetched.mime === "application/gzip" ||
      fetched.mime === "application/x-gzip" ||
      url.endsWith(".gz");
    let bytes: Uint8Array | null = fetched.bytes;
    if (isGzip) {
      try {
        const stream = new Blob([fetched.bytes])
          .stream()
          .pipeThrough(new DecompressionStream("gzip"));
        bytes = await KnowledgeFetchProvider.readCapped(
          stream,
          Constants.KNOWLEDGE_SITEMAP_MAX_BYTES,
        );
      } catch {
        return { isSuccess: false, message: "Sitemap could not be unpacked" };
      }
      if (!bytes) return { isSuccess: false, message: "Sitemap is too large" };
    }

    const xml = new TextDecoder().decode(bytes);
    return { isSuccess: true, parsed: KnowledgeFetchProvider.parseSitemap(xml) };
  }

  // DEV_NOTE: Reads a body up to maxBytes; null when it is longer (the rest is cancelled, never buffered)
  private static async readCapped(
    body: ReadableStream<Uint8Array> | null,
    maxBytes: number,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }
}

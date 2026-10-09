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
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// DEV_NOTE: The first two bytes of every gzip stream (RFC 1952)
const GZIP_MAGIC = [0x1f, 0x8b];

// DEV_NOTE: Fetches web knowledge (M2-5): pages and sitemaps of a company's sitemap / url source. Only http(s) URLs on
// the source's own site are fetched: the site is the host without a leading "www." on the default port, and every
// redirect hop must stay on it (followed by hand, at most KNOWLEDGE_FETCH_MAX_REDIRECTS), so a page can't hand us
// another site's content. Every fetch is capped in time (KNOWLEDGE_FETCH_TIMEOUT_MS, per hop) and size (read as a
// stream, cut off at the cap). Returns { isSuccess, message } and never throws. Fetched text is untrusted content: it is
// stored and searched, never followed as instructions.
export default class KnowledgeFetchProvider {
  static async fetchDocument(
    url: string,
    params: { site: string; maxBytes: number },
  ): Promise<Schemas.KnowledgeFetchResponse> {
    const response: Schemas.KnowledgeFetchResponse = { isSuccess: false };
    const start = KnowledgeFetchProvider.normalizeUrl(url, params.site);
    if (!start) {
      response.message = "URL is not on the source's site";
      return response;
    }
    let current: string = start;

    try {
      for (let hop = 0; hop <= Constants.KNOWLEDGE_FETCH_MAX_REDIRECTS; hop++) {
        const fetched: Response = await fetch(current, {
          headers: {
            "User-Agent": Constants.KNOWLEDGE_FETCH_USER_AGENT,
            Accept:
              "text/html,application/xhtml+xml,application/xml,text/xml,application/pdf,text/plain,text/markdown;q=0.9,*/*;q=0.5",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(Constants.KNOWLEDGE_FETCH_TIMEOUT_MS),
        });

        if (REDIRECT_STATUSES.has(fetched.status)) {
          await fetched.body?.cancel();
          const location = fetched.headers.get("location");
          const next: string | null = location
            ? KnowledgeFetchProvider.normalizeUrl(
                KnowledgeFetchProvider.resolve(location, current),
                params.site,
              )
            : null;
          if (!next) {
            response.message = "Redirect leaves the source's site";
            return response;
          }
          current = next;
          continue;
        }

        if (!fetched.ok) {
          await fetched.body?.cancel();
          response.message = `Fetch answered ${fetched.status}`;
          return response;
        }

        const declaredLength = Number(fetched.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > params.maxBytes) {
          await fetched.body?.cancel();
          response.message = "Response is too large";
          return response;
        }

        const bytes = await KnowledgeFetchProvider.readCapped(fetched.body, params.maxBytes);
        if (!bytes) {
          response.message = "Response is too large";
          return response;
        }

        const [mime, ...parameters] = (fetched.headers.get("content-type") ?? "").split(";");
        const charset = parameters
          .map((parameter) => parameter.trim().toLowerCase())
          .find((parameter) => parameter.startsWith("charset="))
          ?.slice("charset=".length)
          .replace(/"/g, "");
        response.isSuccess = true;
        response.message = "Document fetched successfully";
        response.bytes = bytes;
        response.mime = mime?.trim().toLowerCase() ?? "";
        response.charset = charset || null;
        return response;
      }

      response.message = "Too many redirects";
    } catch (error) {
      const message = "Fetch failed";
      AppLogger.warn({
        category: Schemas.LogCategory.Knowledge,
        action: Schemas.LogAction.FetchKnowledgePage,
        message,
        // DEV_NOTE: A dead or slow site is expected, so warn with the error's name (TimeoutError, TypeError) only
        metadata: { url: current, reason: error instanceof Error ? error.name : "unknown" },
      });
      response.message = message;
    }

    return response;
  }

  // DEV_NOTE: Every page URL of a sitemap, following a sitemap index down to KNOWLEDGE_SITEMAP_MAX_DEPTH levels and
  // reading at most KNOWLEDGE_SITEMAP_MAX_FILES sitemap files. Kept: http(s) on the sitemap's site, fragment removed,
  // each once, at most KNOWLEDGE_MAX_ITEMS_PER_SYNC. The root sitemap must load. A nested one that fails is skipped
  // (logged), and like a cap that cut the walk short it makes the listing incomplete (isComplete false), so the sync
  // prunes nothing from it.
  static async listSitemapUrls(sitemapUrl: string): Promise<Schemas.SitemapUrlsResponse> {
    const response: Schemas.SitemapUrlsResponse = { isSuccess: false };
    const site = KnowledgeFetchProvider.siteOf(sitemapUrl);
    if (!site) {
      response.message = "Sitemap URL is not crawlable";
      return response;
    }

    const urls = new Set<string>();
    const seenSitemaps = new Set<string>();
    let isComplete = true;
    let level = [sitemapUrl];

    for (let depth = 0; level.length > 0; depth++) {
      if (depth > Constants.KNOWLEDGE_SITEMAP_MAX_DEPTH) {
        isComplete = false;
        break;
      }
      const next: string[] = [];
      for (const url of level) {
        if (seenSitemaps.has(url)) continue;
        if (
          urls.size >= Constants.KNOWLEDGE_MAX_ITEMS_PER_SYNC ||
          seenSitemaps.size >= Constants.KNOWLEDGE_SITEMAP_MAX_FILES
        ) {
          isComplete = false;
          break;
        }
        seenSitemaps.add(url);

        const sitemap = await KnowledgeFetchProvider.fetchSitemap(url, site);
        if (!sitemap.isSuccess || !sitemap.parsed) {
          if (depth === 0) {
            response.message = sitemap.message ?? "Sitemap could not be read";
            return response;
          }
          isComplete = false;
          AppLogger.warn({
            category: Schemas.LogCategory.Knowledge,
            action: Schemas.LogAction.ListSitemapUrls,
            message: "Nested sitemap skipped",
            metadata: { url, reason: sitemap.message ?? null },
          });
          continue;
        }

        for (const loc of sitemap.parsed.locs) {
          const normalized = KnowledgeFetchProvider.normalizeUrl(loc, site);
          if (!normalized) continue;
          if (sitemap.parsed.isIndex) {
            next.push(normalized);
          } else if (urls.size < Constants.KNOWLEDGE_MAX_ITEMS_PER_SYNC) {
            urls.add(normalized);
          } else {
            isComplete = false;
          }
        }
      }
      level = next;
    }

    response.isSuccess = true;
    response.message = "Sitemap URLs listed successfully";
    response.urls = [...urls];
    response.isComplete = isComplete;
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

  // DEV_NOTE: Pure: the site a URL belongs to (lowercase host without a leading "www."), or null when it isn't an
  // http(s) URL on the default port with no credentials in it. Source URLs were checked as public domains when the
  // source was created (ZKnowledgeSourceUrl).
  static siteOf(url: string): string | null {
    try {
      const parsed = new URL(url);
      const isCrawlable =
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.port === "";
      return isCrawlable ? parsed.hostname.toLowerCase().replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  }

  // DEV_NOTE: Pure: the URL a page is stored under (knowledge_documents.source_url), or null when it is off the site or
  // not crawlable. The fragment is dropped (same page); the query is kept (it can select different content).
  static normalizeUrl(url: string, site: string): string | null {
    if (KnowledgeFetchProvider.siteOf(url) !== site) return null;
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  }

  // DEV_NOTE: Pure: a page with no heading is titled by the last segment of its path, or its host
  static titleFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      const segment = parsed.pathname.split("/").filter(Boolean).pop();
      const title = segment ? decodeURIComponent(segment).replace(/[-_]+/g, " ") : parsed.host;
      return title.slice(0, Constants.KNOWLEDGE_TITLE_MAX_CHARS);
    } catch {
      return null;
    }
  }

  private static resolve(location: string, base: string): string {
    try {
      return new URL(location, base).href;
    } catch {
      return "";
    }
  }

  private static async fetchSitemap(
    url: string,
    site: string,
  ): Promise<Schemas.ParsedSitemapResponse> {
    const fetched = await KnowledgeFetchProvider.fetchDocument(url, {
      site,
      maxBytes: Constants.KNOWLEDGE_SITEMAP_MAX_BYTES,
    });
    if (!fetched.isSuccess || !fetched.bytes) {
      return { isSuccess: false, message: fetched.message };
    }

    // DEV_NOTE: A sitemap.xml.gz is served as gzip bytes, unless the server also sent Content-Encoding: gzip and fetch
    // already unpacked it, so the bytes decide (gzip magic), not the name or type. Unpacked under the same cap.
    let bytes: Uint8Array | null = fetched.bytes;
    if (fetched.bytes[0] === GZIP_MAGIC[0] && fetched.bytes[1] === GZIP_MAGIC[1]) {
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

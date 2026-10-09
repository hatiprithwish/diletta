import { describe, it, expect, vi, afterEach } from "vitest";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import KnowledgeChunkerProvider from "@/providers/knowledgeChunker";
import KnowledgeFetchProvider from "@/providers/knowledgeFetch";

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Pure parts of knowledge ingestion (M2-5): normalizing, hashing, titles and chunking, and the fetch
// provider's sitemap, site and redirect handling. No database; fetch is stubbed.
afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return await handler(url, init);
  });
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("KnowledgeChunkerProvider.normalizeText and contentHash", () => {
  it("folds line endings, trailing spaces and blank runs, so the same text always hashes the same", async () => {
    const a = KnowledgeChunkerProvider.normalizeText("# Title  \r\n\r\n\r\n\r\nBody text\t\r\n");
    const b = KnowledgeChunkerProvider.normalizeText("# Title\n\nBody text");
    expect(a).toBe("# Title\n\nBody text");
    expect(await KnowledgeChunkerProvider.contentHash(a)).toBe(
      await KnowledgeChunkerProvider.contentHash(b),
    );
  });

  it("drops NUL characters, which Postgres text can't hold", () => {
    expect(KnowledgeChunkerProvider.normalizeText("Re\u0000funds\u0000")).toBe("Refunds");
  });

  it("prefixes the pipeline version and changes for any real edit", async () => {
    const before = await KnowledgeChunkerProvider.contentHash("Refunds take 5 days.");
    const after = await KnowledgeChunkerProvider.contentHash("Refunds take 7 days.");
    expect(before).not.toBe(after);
    expect(before).toMatch(new RegExp(`^${Schemas.KNOWLEDGE_PIPELINE_VERSION}:[0-9a-f]{64}$`));
  });
});

describe("KnowledgeChunkerProvider.extractTitle", () => {
  it("prefers the first level-1 heading, cleaned of markdown", () => {
    const text = "## Intro\n\n# **Billing** [guide](https://x.test)\n\nBody";
    expect(KnowledgeChunkerProvider.extractTitle(text)).toBe("Billing guide");
  });

  it("falls back to the first heading, ignores headings in code, and is null with none", () => {
    expect(KnowledgeChunkerProvider.extractTitle("```\n# not a heading\n```\n\n### Setup")).toBe(
      "Setup",
    );
    expect(KnowledgeChunkerProvider.extractTitle("Just a paragraph.")).toBeNull();
  });

  it("keeps a # that is part of the heading text", () => {
    expect(KnowledgeChunkerProvider.extractTitle("## C#")).toBe("C#");
    expect(KnowledgeChunkerProvider.extractTitle("# Closed ##")).toBe("Closed");
  });
});

describe("KnowledgeChunkerProvider.chunk", () => {
  it("cuts at headings and carries the heading path", () => {
    const text = [
      "# Billing",
      "Intro to billing.",
      "## Refunds",
      "Refunds take 5 days.",
      "### Exceptions",
      "Gift cards are final.",
      "## Invoices",
      "Invoices are monthly.",
    ].join("\n\n");

    const { chunks, isTruncated } = KnowledgeChunkerProvider.chunk(text);

    expect(isTruncated).toBe(false);
    expect(chunks.map((chunk) => [chunk.chunkIndex, chunk.headingPath, chunk.text])).toEqual([
      [0, "Billing", "Intro to billing."],
      [1, "Billing > Refunds", "Refunds take 5 days."],
      [2, "Billing > Refunds > Exceptions", "Gift cards are final."],
      [3, "Billing > Invoices", "Invoices are monthly."],
    ]);
    expect(KnowledgeChunkerProvider.embeddingText(chunks[1]!)).toBe(
      "Billing > Refunds\n\nRefunds take 5 days.",
    );
  });

  it("packs paragraphs within the target, overlap included, and overlaps the next chunk", () => {
    const paragraph = (word: string) => Array.from({ length: 60 }, () => word).join(" ");
    const text = [
      "# Guide",
      paragraph("alpha"),
      paragraph("bravo"),
      paragraph("charlie"),
      paragraph("delta"),
      paragraph("echo"),
    ].join("\n\n");

    const { chunks } = KnowledgeChunkerProvider.chunk(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(Constants.KNOWLEDGE_CHUNK_TARGET_CHARS);
      expect(chunk.headingPath).toBe("Guide");
    }
    const lastWords = chunks[0]!.text.split(" ").slice(-3).join(" ");
    expect(chunks[1]!.text.startsWith(lastWords)).toBe(true);
  });

  it("splits a long paragraph within the target", () => {
    const long = Array.from({ length: 1_000 }, (_, i) => `word${i}`).join(" ");
    const { chunks } = KnowledgeChunkerProvider.chunk(`# Long\n\n${long}`);
    expect(chunks.length).toBeGreaterThan(2);
    expect(
      chunks.every((chunk) => chunk.text.length <= Constants.KNOWLEDGE_CHUNK_TARGET_CHARS),
    ).toBe(true);
  });

  it("keeps a fence whole until its own marker closes it", () => {
    const fenced = KnowledgeChunkerProvider.chunk(
      "# Code\n\n```\n# comment\n\n~~~\n## still code\n```\n\nAfter.",
    );
    // DEV_NOTE: "## still code" stayed inside the fence (no new section), and the paragraph after it packs with it
    expect(fenced.chunks.map((chunk) => chunk.headingPath)).toEqual(["Code"]);
    expect(fenced.chunks[0]?.text).toContain("## still code");
    expect(fenced.chunks[0]?.text.endsWith("```\n\nAfter.")).toBe(true);
  });

  it("keeps text that exists only in leaf headings, not empty parents", () => {
    const { chunks } = KnowledgeChunkerProvider.chunk(
      "# FAQ\n\n## Can I pay by card?\n\n## Is there a trial?",
    );
    expect(chunks.map((chunk) => [chunk.headingPath, chunk.text])).toEqual([
      ["FAQ > Can I pay by card?", "Can I pay by card?"],
      ["FAQ > Is there a trial?", "Is there a trial?"],
    ]);
  });

  it("clips very long headings and heading paths", () => {
    const long = "x".repeat(1_000);
    const { chunks } = KnowledgeChunkerProvider.chunk(
      `# ${long}\n\n## ${long}\n\n### ${long}\n\n#### ${long}\n\nBody`,
    );
    expect(chunks[0]!.headingPath!.length).toBeLessThanOrEqual(
      Constants.KNOWLEDGE_HEADING_PATH_MAX_CHARS,
    );
  });

  it("caps the chunks of one document", () => {
    const sections = Array.from(
      { length: Constants.KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT + 5 },
      (_, i) => `## Section ${i}\n\nBody ${i}.`,
    ).join("\n\n");
    const { chunks, isTruncated } = KnowledgeChunkerProvider.chunk(sections);
    expect(isTruncated).toBe(true);
    expect(chunks).toHaveLength(Constants.KNOWLEDGE_MAX_CHUNKS_PER_DOCUMENT);
  });
});

describe("KnowledgeFetchProvider pure helpers", () => {
  it("parses urlsets and sitemap indexes, decoding entities and CDATA", () => {
    const urlset = `<?xml version="1.0"?><urlset><url><loc> https://docs.test/a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[https://docs.test/b]]></loc></url></urlset>`;
    expect(KnowledgeFetchProvider.parseSitemap(urlset)).toEqual({
      isIndex: false,
      locs: ["https://docs.test/a?x=1&y=2", "https://docs.test/b"],
    });
    const index = `<sitemapindex><sitemap><loc>https://docs.test/s1.xml</loc></sitemap></sitemapindex>`;
    expect(KnowledgeFetchProvider.parseSitemap(index)).toEqual({
      isIndex: true,
      locs: ["https://docs.test/s1.xml"],
    });
  });

  it("treats www and the apex as one site, and refuses ports, credentials and other schemes", () => {
    expect(KnowledgeFetchProvider.siteOf("https://www.Docs.test/a")).toBe("docs.test");
    expect(KnowledgeFetchProvider.siteOf("https://docs.test:8443/a")).toBeNull();
    const site = "docs.test";
    expect(KnowledgeFetchProvider.normalizeUrl("https://docs.test/a#top", site)).toBe(
      "https://docs.test/a",
    );
    expect(KnowledgeFetchProvider.normalizeUrl("https://www.docs.test/a", site)).toBe(
      "https://www.docs.test/a",
    );
    expect(KnowledgeFetchProvider.normalizeUrl("https://evil.test/a", site)).toBeNull();
    expect(KnowledgeFetchProvider.normalizeUrl("ftp://docs.test/a", site)).toBeNull();
    expect(KnowledgeFetchProvider.normalizeUrl("https://user:pw@docs.test/a", site)).toBeNull();
    expect(KnowledgeFetchProvider.normalizeUrl("not a url", site)).toBeNull();
  });

  it("titles a page from its URL", () => {
    expect(KnowledgeFetchProvider.titleFromUrl("https://docs.test/guides/getting-started")).toBe(
      "getting started",
    );
    expect(KnowledgeFetchProvider.titleFromUrl("https://docs.test/")).toBe("docs.test");
  });
});

describe("KnowledgeFetchProvider.fetchDocument", () => {
  const params = { site: "docs.test", maxBytes: 1_000 };

  it("follows a redirect that stays on the site", async () => {
    stubFetch((url, init) => {
      expect(init?.redirect).toBe("manual");
      return url === "https://docs.test/old"
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : new Response("# New", { headers: { "content-type": "text/markdown; charset=UTF-8" } });
    });
    const fetched = await KnowledgeFetchProvider.fetchDocument("https://docs.test/old", params);
    expect(fetched.isSuccess).toBe(true);
    expect(fetched.mime).toBe("text/markdown");
    expect(fetched.charset).toBe("utf-8");
    expect(new TextDecoder().decode(fetched.bytes)).toBe("# New");
  });

  it("refuses a redirect to another site without fetching it", async () => {
    const fetchSpy = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "https://attacker.test/x" } }),
    );
    const fetched = await KnowledgeFetchProvider.fetchDocument("https://docs.test/a", params);
    expect(fetched).toEqual({ isSuccess: false, message: "Redirect leaves the source's site" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("stops after too many redirects", async () => {
    let hop = 0;
    stubFetch(() => new Response(null, { status: 302, headers: { location: `/hop${++hop}` } }));
    const fetched = await KnowledgeFetchProvider.fetchDocument("https://docs.test/a", params);
    expect(fetched).toEqual({ isSuccess: false, message: "Too many redirects" });
  });

  it("refuses a URL off the site before any fetch", async () => {
    const fetchSpy = stubFetch(() => new Response("x"));
    const fetched = await KnowledgeFetchProvider.fetchDocument("https://other.test/a", params);
    expect(fetched.isSuccess).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cuts a streamed body over the cap (no content-length)", async () => {
    stubFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(400));
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    });
    const fetched = await KnowledgeFetchProvider.fetchDocument("https://docs.test/big", params);
    expect(fetched).toEqual({ isSuccess: false, message: "Response is too large" });
  });

  it("fails a fetch that times out", async () => {
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const fetched = await KnowledgeFetchProvider.fetchDocument("https://docs.test/slow", params);
    expect(fetched).toEqual({ isSuccess: false, message: "Fetch failed" });
  });
});

describe("KnowledgeFetchProvider.listSitemapUrls", () => {
  it("follows an index, keeps same-site pages once, and reports a broken child as incomplete", async () => {
    const files: Record<string, string> = {
      "https://docs.test/sitemap.xml": `<sitemapindex><sitemap><loc>https://docs.test/s1.xml</loc></sitemap><sitemap><loc>https://docs.test/broken.xml</loc></sitemap></sitemapindex>`,
      "https://docs.test/s1.xml": `<urlset><url><loc>https://docs.test/a</loc></url><url><loc>https://docs.test/a#dup</loc></url><url><loc>https://other.test/x</loc></url><url><loc>https://www.docs.test/b</loc></url></urlset>`,
    };
    stubFetch((url) => {
      const body = files[url];
      return body
        ? new Response(body, { headers: { "content-type": "application/xml" } })
        : new Response("missing", { status: 503 });
    });

    const listed = await KnowledgeFetchProvider.listSitemapUrls("https://docs.test/sitemap.xml");

    expect(listed.isSuccess).toBe(true);
    expect(listed.urls).toEqual(["https://docs.test/a", "https://www.docs.test/b"]);
    expect(listed.isComplete).toBe(false);
  });

  it("is complete when every sitemap loads, and unpacks a gzip sitemap by its bytes", async () => {
    const gzipped = await gzip(`<urlset><url><loc>https://docs.test/a</loc></url></urlset>`);
    stubFetch(
      () => new Response(gzipped, { headers: { "content-type": "application/octet-stream" } }),
    );
    const listed = await KnowledgeFetchProvider.listSitemapUrls("https://docs.test/sitemap.xml.gz");
    expect(listed).toMatchObject({
      isSuccess: true,
      urls: ["https://docs.test/a"],
      isComplete: true,
    });
  });

  it("reads at most KNOWLEDGE_SITEMAP_MAX_FILES sitemap files", async () => {
    const children = Array.from(
      { length: Constants.KNOWLEDGE_SITEMAP_MAX_FILES + 5 },
      (_, i) => `<sitemap><loc>https://docs.test/s${i}.xml</loc></sitemap>`,
    ).join("");
    const fetchSpy = stubFetch((url) =>
      url.endsWith("/sitemap.xml")
        ? new Response(`<sitemapindex>${children}</sitemapindex>`)
        : new Response(`<urlset><url><loc>${url.replace(".xml", "")}</loc></url></urlset>`),
    );
    const listed = await KnowledgeFetchProvider.listSitemapUrls("https://docs.test/sitemap.xml");
    expect(fetchSpy).toHaveBeenCalledTimes(Constants.KNOWLEDGE_SITEMAP_MAX_FILES);
    expect(listed.isComplete).toBe(false);
  });

  it("fails when the root sitemap can't be read", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const listed = await KnowledgeFetchProvider.listSitemapUrls("https://docs.test/sitemap.xml");
    expect(listed.isSuccess).toBe(false);
  });
});

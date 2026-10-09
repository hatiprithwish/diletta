import { describe, it, expect, vi, afterEach } from "vitest";
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
// provider's sitemap and URL handling. No database; fetch is stubbed where a sitemap is walked.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("KnowledgeChunkerProvider.normalizeText and hashText", () => {
  it("folds line endings, trailing spaces and blank runs, so the same text always hashes the same", async () => {
    const a = KnowledgeChunkerProvider.normalizeText("# Title  \r\n\r\n\r\n\r\nBody text\t\r\n");
    const b = KnowledgeChunkerProvider.normalizeText("# Title\n\nBody text");
    expect(a).toBe("# Title\n\nBody text");
    expect(await KnowledgeChunkerProvider.hashText(a)).toBe(
      await KnowledgeChunkerProvider.hashText(b),
    );
  });

  it("changes the hash for any real edit", async () => {
    const before = await KnowledgeChunkerProvider.hashText("Refunds take 5 days.");
    const after = await KnowledgeChunkerProvider.hashText("Refunds take 7 days.");
    expect(before).not.toBe(after);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
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

  it("packs paragraphs up to the target and overlaps the next chunk of the same section", () => {
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
      expect(chunk.text.length).toBeLessThanOrEqual(
        Constants.KNOWLEDGE_CHUNK_TARGET_CHARS + Constants.KNOWLEDGE_CHUNK_OVERLAP_CHARS + 2,
      );
      expect(chunk.headingPath).toBe("Guide");
    }
    // DEV_NOTE: The second chunk starts with the tail of the first
    const tailOfFirst = chunks[0]!.text.slice(-50).trim();
    expect(chunks[1]!.text.startsWith(tailOfFirst.split(" ").slice(-3).join(" "))).toBe(true);
  });

  it("splits a paragraph longer than the target and keeps a code fence whole as one paragraph", () => {
    const long = Array.from({ length: 1_000 }, (_, i) => `word${i}`).join(" ");
    const { chunks } = KnowledgeChunkerProvider.chunk(`# Long\n\n${long}`);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.text.length > 0)).toBe(true);

    const fenced = KnowledgeChunkerProvider.chunk("# Code\n\n```\n# comment\n\nline\n```");
    expect(fenced.chunks).toHaveLength(1);
    expect(fenced.chunks[0]?.headingPath).toBe("Code");
    expect(fenced.chunks[0]?.text).toContain("# comment");
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

  it("makes no chunks from headings alone", () => {
    expect(KnowledgeChunkerProvider.chunk("# Only\n\n## Headings").chunks).toEqual([]);
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

  it("keeps same-host http(s) URLs only and drops the fragment", () => {
    const host = "docs.test";
    expect(KnowledgeFetchProvider.normalizeUrl("https://docs.test/a#top", host)).toBe(
      "https://docs.test/a",
    );
    expect(KnowledgeFetchProvider.normalizeUrl("https://evil.test/a", host)).toBeNull();
    expect(KnowledgeFetchProvider.normalizeUrl("ftp://docs.test/a", host)).toBeNull();
    expect(KnowledgeFetchProvider.normalizeUrl("https://user:pw@docs.test/a", host)).toBeNull();
    expect(KnowledgeFetchProvider.normalizeUrl("not a url", host)).toBeNull();
  });
});

describe("KnowledgeFetchProvider.listSitemapUrls", () => {
  it("follows an index, keeps same-host pages once, and skips a broken child", async () => {
    const files: Record<string, string> = {
      "https://docs.test/sitemap.xml": `<sitemapindex><sitemap><loc>https://docs.test/s1.xml</loc></sitemap><sitemap><loc>https://docs.test/broken.xml</loc></sitemap></sitemapindex>`,
      "https://docs.test/s1.xml": `<urlset><url><loc>https://docs.test/a</loc></url><url><loc>https://docs.test/a#dup</loc></url><url><loc>https://other.test/x</loc></url><url><loc>https://docs.test/b</loc></url></urlset>`,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = files[url];
      return body
        ? new Response(body, { headers: { "content-type": "application/xml" } })
        : new Response("missing", { status: 404 });
    });

    const listed = await KnowledgeFetchProvider.listSitemapUrls("https://docs.test/sitemap.xml");

    expect(listed.isSuccess).toBe(true);
    expect(listed.urls).toEqual(["https://docs.test/a", "https://docs.test/b"]);
  });

  it("fails when the root sitemap can't be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const listed = await KnowledgeFetchProvider.listSitemapUrls("https://docs.test/sitemap.xml");
    expect(listed.isSuccess).toBe(false);
  });

  it("refuses a page larger than the cap without buffering it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x".repeat(2_000), { headers: { "content-type": "text/plain" } }),
    );
    const fetched = await KnowledgeFetchProvider.fetchDocument("https://docs.test/big", 1_000);
    expect(fetched).toEqual({ isSuccess: false, message: "Response is too large" });
  });
});

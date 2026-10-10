import { describe, it, expect } from "vitest";
import { citedBy, splitCitationMarkers } from "./KnowledgeSearchCitations";
import type { KnowledgeCitation } from "./KnowledgeSearchCommon";

const citation = (n: number): KnowledgeCitation => ({
  n,
  documentPublicId: `doc-${n}`,
  title: `Doc ${n}`,
  sourceUrl: null,
});

describe("citedBy", () => {
  it("keeps the cited citations once each, in number order, ignoring made-up numbers", () => {
    const cited = citedBy("Yes [3]. Also [1,3] and [ 2 ] and [9].", [1, 2, 3].map(citation));
    expect(cited.map((entry) => entry.n)).toEqual([1, 3]);
  });

  it("skips code, indexes and links", () => {
    const text = "Use `items[1]` or a[1][2], see [2](https://x.test) and ```\n[3]\n```. Done [1].";
    expect(citedBy(text, [1, 2, 3].map(citation)).map((entry) => entry.n)).toEqual([1]);
  });

  it("returns plain citations, nothing else the input carried", () => {
    const extra = { ...citation(1), text: "excerpt" };
    expect(citedBy("See [1].", [extra])[0]).toEqual(citation(1));
  });
});

describe("splitCitationMarkers", () => {
  it("cuts the text at its markers, keeping the numbers each one cites", () => {
    expect(splitCitationMarkers("Open settings [1]. Then [1, 2].")).toEqual([
      "Open settings ",
      [1],
      ". Then ",
      [1, 2],
      ".",
    ]);
  });

  it("leaves indexes and links alone", () => {
    expect(splitCitationMarkers("a[1] and [here](x)")).toEqual(["a[1] and [here](x)"]);
  });
});

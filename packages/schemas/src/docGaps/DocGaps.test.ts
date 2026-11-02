import { describe, it, expect } from "vitest";
import { SearchHelpDocsStatusEnum } from "../knowledgeSearch/KnowledgeSearchCommon";
import {
  docGapCandidateSignal,
  docGapClusterOpensQualityIssue,
  docGapQuestionHasPersonalDetails,
  DocGapSignalIntEnum,
  nextDocGapCentroid,
  parseDocGapRewrite,
} from "./DocGapsCommon";

const { Found, NoResults, Unavailable } = SearchHelpDocsStatusEnum;
const candidate = (searchStatuses: SearchHelpDocsStatusEnum[], hasCitations = false) =>
  docGapCandidateSignal({
    searchStatuses,
    hasReply: true,
    hasCitations,
    hasUnfinishedTool: false,
    hasWithheldSearch: false,
    isInjectionFlagged: false,
  });

describe("docGapCandidateSignal", () => {
  it("is LowRetrieval when every search was empty, Idk when one found something the reply didn't cite", () => {
    expect(candidate([NoResults])).toBe(DocGapSignalIntEnum.LowRetrieval);
    expect(candidate([NoResults, NoResults])).toBe(DocGapSignalIntEnum.LowRetrieval);
    expect(candidate([Found])).toBe(DocGapSignalIntEnum.Idk);
    expect(candidate([NoResults, Found])).toBe(DocGapSignalIntEnum.Idk);
  });

  it("is no candidate with no search, a cited reply, no reply or an unavailable search", () => {
    expect(candidate([])).toBeNull();
    expect(candidate([Found], true)).toBeNull();
    expect(candidate([Unavailable])).toBeNull();
    expect(candidate([Found, Unavailable])).toBeNull();
    expect(
      docGapCandidateSignal({
        searchStatuses: [Found],
        hasReply: false,
        hasCitations: false,
        hasUnfinishedTool: false,
        hasWithheldSearch: false,
        isInjectionFlagged: false,
      }),
    ).toBeNull();
    expect(
      docGapCandidateSignal({
        searchStatuses: [NoResults],
        hasReply: true,
        hasCitations: false,
        hasUnfinishedTool: true,
        hasWithheldSearch: false,
        isInjectionFlagged: false,
      }),
    ).toBeNull();
    // DEV_NOTE: M6-4: a withheld hit means the doc exists; a flagged conversation's text stays away from the rewrite
    for (const flags of [
      { hasWithheldSearch: true, isInjectionFlagged: false },
      { hasWithheldSearch: false, isInjectionFlagged: true },
    ]) {
      expect(
        docGapCandidateSignal({
          searchStatuses: [NoResults],
          hasReply: true,
          hasCitations: false,
          hasUnfinishedTool: false,
          ...flags,
        }),
      ).toBeNull();
    }
  });
});

describe("docGapQuestionHasPersonalDetails", () => {
  it("catches emails and long numbers, and leaves plain questions alone", () => {
    expect(docGapQuestionHasPersonalDetails("Can a.b@c.co log in?")).toBe(true);
    expect(docGapQuestionHasPersonalDetails("Call +1 (415) 555-0100?")).toBe(true);
    expect(docGapQuestionHasPersonalDetails("Where is record 882133?")).toBe(true);
    expect(docGapQuestionHasPersonalDetails("What changed in version 2.14?")).toBe(false);
    expect(docGapQuestionHasPersonalDetails("How do I archive a register in 2026?")).toBe(false);
  });
});

describe("parseDocGapRewrite", () => {
  it("keeps a clean unanswered question, trimmed", () => {
    expect(parseDocGapRewrite({ wasUnanswered: true, questionGeneric: " Why? " })).toBe("Why?");
  });

  it("is null when answered, empty, too long or holding personal details", () => {
    expect(parseDocGapRewrite({ wasUnanswered: false, questionGeneric: "Why?" })).toBeNull();
    expect(parseDocGapRewrite({ wasUnanswered: true, questionGeneric: "  " })).toBeNull();
    expect(
      parseDocGapRewrite({ wasUnanswered: true, questionGeneric: "x".repeat(301) }),
    ).toBeNull();
    expect(
      parseDocGapRewrite({ wasUnanswered: true, questionGeneric: "Is a@b.co ok?" }),
    ).toBeNull();
  });
});

describe("nextDocGapCentroid", () => {
  it("is the running mean", () => {
    expect(nextDocGapCentroid([1, 0], 3, [0, 1])).toEqual([0.75, 0.25]);
  });
});

describe("docGapClusterOpensQualityIssue", () => {
  const opens = (isOpen: boolean, questionCount: number, userCount: number) =>
    docGapClusterOpensQualityIssue({ isOpen, questionCount, userCount });

  it("needs an Open group over both floors, and never a single question", () => {
    expect(opens(true, 1, 1)).toBe(false);
    expect(opens(true, 4, 3)).toBe(false);
    expect(opens(true, 5, 2)).toBe(false);
    expect(opens(true, 5, 3)).toBe(true);
    expect(opens(false, 50, 50)).toBe(false);
  });
});

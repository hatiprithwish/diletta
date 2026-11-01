import { describe, expect, it } from "vitest";
import { EvalCaseMessageRoleEnum } from "../evalCases";
import {
  findQualityTestPersonalDetails,
  qualityTestDraftHasTerm,
  unconfirmedQualityTestTerms,
  withQualityTestCheckedNames,
} from "./QualityIssuesCommon";

const draftOf = (text: string) => ({
  name: "A test",
  messages: [{ role: EvalCaseMessageRoleEnum.User, text }],
  rubric: "Answers the question.",
});
const find = (text: string, sourceTexts: string[] = [], userName: string | null = null) =>
  findQualityTestPersonalDetails({ draft: draftOf(text), sourceTexts, userName });

describe("findQualityTestPersonalDetails", () => {
  it("blocks the chat user's name, an email and a long number, in any case", () => {
    expect(find("Can priya log in?", [], "Priya Shah")).toEqual([
      { term: "Priya", canConfirm: false },
    ]);
    expect(find("Write to a.b@c.co")).toEqual([{ term: "a.b@c.co", canConfirm: false }]);
    expect(find("Where is record 882133")).toEqual([{ term: "882133", canConfirm: false }]);
  });

  it("flags a name-like word of the chat that the test repeats, for the admin to judge", () => {
    const source = ["Can you ask Daniel O'Brien about Invoice Hub?"];
    expect(find("Can you ask Daniel about it?", source)).toEqual([
      { term: "Daniel", canConfirm: true },
    ]);
    expect(find("How does the invoice export work?", source)).toEqual([
      { term: "Invoice", canConfirm: true },
    ]);
    expect(find("Can you ask a colleague about it?", source)).toEqual([]);
  });

  it("leaves out sentence openers, all-caps words, I'm and calendar words", () => {
    const source = ["Hello there. Export works, and I'm on the CSV plan since Monday"];
    expect(find("Hello, export the CSV on monday. I'm stuck.", source)).toEqual([]);
  });

  it("leaves out a word the chat also writes in lowercase", () => {
    expect(find("Fire drills", ["Per the Fire policy.", "how often are fire drills?"])).toEqual([]);
  });

  it("matches whole words only", () => {
    expect(qualityTestDraftHasTerm(draftOf("Priyanka"), "Priya")).toBe(false);
    expect(qualityTestDraftHasTerm(draftOf("Is (priya) in"), "Priya")).toBe(true);
    expect(qualityTestDraftHasTerm(draftOf("c++ guide"), "c++")).toBe(true);
  });

  it("checks the name and rubric too", () => {
    const draft = { ...draftOf("Hi"), name: "Priya's login", rubric: "Calls 4155550100." };
    expect(findQualityTestPersonalDetails({ draft, sourceTexts: [], userName: "Priya" })).toEqual([
      { term: "4155550100", canConfirm: false },
      { term: "Priya", canConfirm: false },
    ]);
  });
});

describe("unconfirmedQualityTestTerms", () => {
  it("lets a confirmed word through, never a term that can't be confirmed", () => {
    const flagged = [
      { term: "Invoice", canConfirm: true },
      { term: "Priya", canConfirm: false },
    ];
    expect(unconfirmedQualityTestTerms(flagged, ["invoice", "priya"])).toEqual([flagged[1]]);
  });
});

describe("withQualityTestCheckedNames", () => {
  it("adds only names the test holds, each once", () => {
    const flagged = [{ term: "Priya", canConfirm: false }];
    expect(
      withQualityTestCheckedNames(flagged, draftOf("priya asks john"), [
        " john ",
        "John",
        "priya",
        "Mina",
      ]),
    ).toEqual([...flagged, { term: "john", canConfirm: true }]);
  });
});

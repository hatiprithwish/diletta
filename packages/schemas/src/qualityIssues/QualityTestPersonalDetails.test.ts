import { describe, expect, it } from "vitest";
import { EvalCaseMessageRoleEnum } from "../evalCases";
import {
  findQualityTestPersonalDetails,
  qualityTestDraftHasTerm,
  unconfirmedQualityTestTerms,
  withQualityTestCheckedNames,
} from "./QualityTestPersonalDetails";

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

  it("handles terms with a hyphen on every path", () => {
    expect(find("Wi-Fi help", ["Is the Wi-Fi down?"])).toEqual([
      { term: "Wi-Fi", canConfirm: true },
    ]);
    expect(find("Can mary-jane log in?", [], "Mary-Jane Doe")).toEqual([
      { term: "Mary-Jane", canConfirm: false },
    ]);
    expect(find("Call 415-555-0100")).toEqual([{ term: "415-555-0100", canConfirm: false }]);
    expect(qualityTestDraftHasTerm(draftOf("Call 415-555-0100"), "415-555-0100")).toBe(true);
    expect(qualityTestDraftHasTerm(draftOf("a first-last@acme.com"), "first-last@acme.com")).toBe(
      true,
    );
    expect(withQualityTestCheckedNames([], draftOf("ask jean-luc"), ["jean-luc"])).toEqual([
      { term: "jean-luc", canConfirm: true },
    ]);
  });

  it("finds a number inside a word the way it was flagged", () => {
    const draft = draftOf("Open ID12345678");
    expect(find("Open ID12345678")).toEqual([{ term: "12345678", canConfirm: false }]);
    expect(qualityTestDraftHasTerm(draft, "12345678")).toBe(true);
  });

  it("doesn't block an everyday word that is part of the user's name", () => {
    expect(find("The reply will explain it", [], "Will Smith")).toEqual([]);
    expect(find("Asks for an invoice", [], "An Nguyen")).toEqual([]);
    expect(find("Can Will log in?", [], "Will Smith")).toEqual([
      { term: "Will", canConfirm: true },
    ]);
  });

  it("skips what a host sends in place of a name", () => {
    expect(find("What can the user do?", [], "Test User")).toEqual([]);
  });

  it("finds a possessive's name without its 's", () => {
    expect(find("Can you ask Daniel?", ["please reset Daniel's password"])).toEqual([
      { term: "Daniel", canConfirm: true },
    ]);
    expect(find("Can you ask Daniel’s team?", ["please reset Daniel’s password"])).toEqual([
      { term: "Daniel", canConfirm: true },
    ]);
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

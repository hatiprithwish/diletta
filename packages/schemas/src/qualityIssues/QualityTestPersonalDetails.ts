import {
  hasPersonalDetailPattern,
  PERSONAL_EMAIL_PATTERN,
  PERSONAL_LONG_NUMBER_PATTERN,
} from "../personalDetails";
import type { QualityTestDraft } from "./QualityIssuesCommon";

export const QUALITY_TEST_TERM_MAX_CHARS = 200;
export const QUALITY_TEST_CONFIRMED_TERMS_MAX = 100;

// DEV_NOTE: A term the review must deal with. canConfirm false = always personal (the chat user's name, an email, a long
// number): it can only be edited out. true = may be an ordinary word: the admin edits it out or confirms it isn't
// personal.
export interface QualityTestFlaggedTerm {
  term: string;
  canConfirm: boolean;
}

// DEV_NOTE: The review as the dialog holds it. wasVerified false = the name check's model call didn't run.
export interface QualityTestReview {
  draft: QualityTestDraft;
  flaggedTerms: QualityTestFlaggedTerm[];
  wasVerified: boolean;
}

// DEV_NOTE: A capitalised word that doesn't open a sentence, so it reads as a name. All-caps words, "I'm" and calendar
// words are left out: they are what a chat is full of and never a person.
const QUALITY_TEST_NAME_LIKE_WORD =
  /(?<![\p{L}\p{N}'’-])(?<![.!?…:;\n"“(]\s*)(?<!^\s*)\p{Lu}\p{L}*(?:['’-]\p{L}+)*/gu;
const QUALITY_TEST_FIRST_PERSON = /^I['’]/;
const QUALITY_TEST_POSSESSIVE = /['’]s$/i;
const QUALITY_TEST_CALENDAR_WORDS = new Set(
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december".split(
    " ",
  ),
);
const QUALITY_TEST_USER_NAME_PART_MIN_CHARS = 2;
// DEV_NOTE: What a host sends in place of a name ("Test User"): never a person, and every rubric says "the user"
const QUALITY_TEST_GENERIC_NAME_PARTS = new Set(
  "user guest test admin customer member demo visitor anonymous unknown".split(" "),
);
// DEV_NOTE: Names that are also everyday English ("Will Smith" and "the reply will explain"). Such a part counts only
// written as the name is, and the admin may confirm it (a sentence can open with "Will").
const QUALITY_TEST_ORDINARY_NAME_PARTS = new Set(
  "an art ash baker bell bill bishop black brown bush carter chase clay cook dawn day do drew faith fisher ford frank gay gene grace grant gray green hall hill holly hope hunter ivy jack joy king lane lee long love mark mason may miles miller moon mr mrs ms park parker pat penny price reed rich rob rose ruby sandy short skip smith star sue summer taylor tony turner van walker ward white will wolf wood young".split(
    " ",
  ),
);

function qualityTestDraftText(draft: QualityTestDraft): string {
  return [draft.name, ...draft.messages.map((message) => message.text), draft.rubric].join("\n");
}

// DEV_NOTE: Whole word: "Priya" is never found in "Priyanka"
function qualityTestTermPattern(term: string, flags: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, flags);
}

// DEV_NOTE: In any case: a name the rewrite lowercased is still that name. An email or number is found wherever it sits,
// as findQualityTestPersonalDetails found it ("ID12345678").
export function qualityTestDraftHasTerm(draft: QualityTestDraft, term: string): boolean {
  const text = qualityTestDraftText(draft);
  return hasPersonalDetailPattern(term)
    ? text.toLowerCase().includes(term.toLowerCase())
    : qualityTestTermPattern(term, "iu").test(text);
}

function qualityTestNameLikeWords(text: string): string[] {
  return Array.from(text.matchAll(QUALITY_TEST_NAME_LIKE_WORD), (match) =>
    match[0].replace(QUALITY_TEST_POSSESSIVE, ""),
  ).filter(
    (word) =>
      word !== word.toUpperCase() &&
      !QUALITY_TEST_FIRST_PERSON.test(word) &&
      !QUALITY_TEST_CALENDAR_WORDS.has(word.toLowerCase()),
  );
}

// DEV_NOTE: The check Create test's draft and save both run (M5-7), pure: the test against what it was made from. Blocked
// outright: an email or long number anywhere in it, a part of the chat user's name. For the admin to judge: a name part
// that is also an everyday word, and a name-like word of the chat or note that the test repeats. A name opening a
// sentence or written in lowercase isn't seen here; the model's check at draft flags those.
export function findQualityTestPersonalDetails(params: {
  draft: QualityTestDraft;
  sourceTexts: string[];
  userName: string | null;
}): QualityTestFlaggedTerm[] {
  const { draft, sourceTexts, userName } = params;
  const text = qualityTestDraftText(draft);
  const found = new Map<string, QualityTestFlaggedTerm>();
  const add = (term: string, canConfirm: boolean) => {
    const key = term.toLowerCase();
    if (!found.has(key)) found.set(key, { term, canConfirm });
  };

  for (const pattern of [PERSONAL_EMAIL_PATTERN, PERSONAL_LONG_NUMBER_PATTERN]) {
    for (const match of text.matchAll(new RegExp(pattern.source, "g"))) add(match[0], false);
  }
  for (const part of userName?.split(/\s+/) ?? []) {
    const lower = part.toLowerCase();
    if (part.length < QUALITY_TEST_USER_NAME_PART_MIN_CHARS) continue;
    if (QUALITY_TEST_GENERIC_NAME_PARTS.has(lower)) continue;
    if (QUALITY_TEST_ORDINARY_NAME_PARTS.has(lower)) {
      if (qualityTestTermPattern(part, "u").test(text)) add(part, true);
    } else if (qualityTestDraftHasTerm(draft, part)) {
      add(part, false);
    }
  }
  // DEV_NOTE: A word the chat also writes in lowercase is an ordinary word ("the Fire policy", "fire drills")
  const source = sourceTexts.join("\n");
  for (const word of sourceTexts.flatMap(qualityTestNameLikeWords)) {
    if (qualityTestTermPattern(word.toLowerCase(), "u").test(source)) continue;
    if (qualityTestDraftHasTerm(draft, word)) add(word, true);
  }
  return [...found.values()];
}

// DEV_NOTE: The name check's answer added to the flagged terms: only what the test really holds, each for the admin to
// judge
export function withQualityTestCheckedNames(
  flagged: QualityTestFlaggedTerm[],
  draft: QualityTestDraft,
  names: string[],
): QualityTestFlaggedTerm[] {
  const seen = new Set(flagged.map(({ term }) => term.toLowerCase()));
  const added: QualityTestFlaggedTerm[] = [];
  for (const name of names.map((value) => value.trim())) {
    if (name.length < QUALITY_TEST_USER_NAME_PART_MIN_CHARS) continue;
    if (name.length > QUALITY_TEST_TERM_MAX_CHARS || seen.has(name.toLowerCase())) continue;
    if (!qualityTestDraftHasTerm(draft, name)) continue;
    seen.add(name.toLowerCase());
    added.push({ term: name, canConfirm: true });
  }
  return [...flagged, ...added];
}

// DEV_NOTE: What still stops a save: a term that can't be confirmed, or one the admin didn't
export function unconfirmedQualityTestTerms(
  flagged: QualityTestFlaggedTerm[],
  confirmedTerms: string[],
): QualityTestFlaggedTerm[] {
  const confirmed = new Set(confirmedTerms.map((term) => term.toLowerCase()));
  return flagged.filter(
    ({ term, canConfirm }) => !canConfirm || !confirmed.has(term.toLowerCase()),
  );
}

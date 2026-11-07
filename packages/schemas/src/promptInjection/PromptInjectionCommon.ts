// DEV_NOTE: Prompt-injection detection (M6-4): a pure, versioned set of pattern rules run over the text that reaches the
// model from outside the config: the user's message, help doc excerpts and what a host read returns. It can't catch
// every injection (the architecture's stance: limit the blast radius); it catches the common phrasings so they are
// logged and blocked, and the platform safety cases check the chatbot's behaviour for the rest. The rules aim at
// instructions to the model, not at topics: each needs an object aimed at the assistant ("your instructions", "all
// previous instructions", "your system prompt"), so a help page about setup instructions, a record about override
// rules or a user correcting themselves passes. A change to the rules bumps PROMPT_INJECTION_RULES_VERSION (recorded
// with every detection).

export const PROMPT_INJECTION_RULES_VERSION = 2;

// DEV_NOTE: How much of one text is scanned; a longer one is scanned up to here (the model sees at most
// HOST_TOOL_OUTPUT_MAX_CHARS of a host read, and user messages and excerpts are shorter)
export const PROMPT_INJECTION_SCAN_MAX_CHARS = 20_000;

// DEV_NOTE: How deep a host read's JSON is walked; anything deeper is replaced by PROMPT_INJECTION_TOO_DEEP_TEXT unread
// (no real record nests this far, and it keeps the walk off the call stack's limit)
export const PROMPT_INJECTION_JSON_MAX_DEPTH = 32;
export const PROMPT_INJECTION_WITHHELD_TEXT =
  "[withheld: it held instructions aimed at the assistant]";
export const PROMPT_INJECTION_TOO_DEEP_TEXT = "[not shown: nested too deeply]";

// DEV_NOTE: The event a detection records (ids, where and which rule: never the text), on the conversation it was found
// in. One per help doc, ever (a doc the company wrote is the same doc in every conversation, so it opens one issue,
// not one per chat), and one per conversation and location otherwise. A repeat is logged only.
export const PROMPT_INJECTION_EVENT_TYPE = "prompt_injection.detected";
export const PROMPT_INJECTION_ENTITY_TYPE = "conversation";
export const PROMPT_INJECTION_ENTITY_ACTION = "prompt_injection_detected";

export enum PromptInjectionLocationEnum {
  UserMessage = "user_message",
  HelpDoc = "help_doc",
  HostData = "host_data",
  // DEV_NOTE: A visitor's note on a rating (M7-10): checked before it is stored, a flagged one is never stored
  FeedbackNote = "feedback_note",
}

export enum PromptInjectionRuleEnum {
  IgnoreInstructions = "ignore_instructions",
  RoleTakeover = "role_takeover",
  RevealPrompt = "reveal_prompt",
  FakeRoleMarker = "fake_role_marker",
  FakeApproval = "fake_approval",
  Exfiltration = "exfiltration",
}

export const PROMPT_INJECTION_RULE_LABEL_MAP: Record<PromptInjectionRuleEnum, string> = {
  [PromptInjectionRuleEnum.IgnoreInstructions]: "told the chatbot to ignore its instructions",
  [PromptInjectionRuleEnum.RoleTakeover]: "tried to switch the chatbot into another role",
  [PromptInjectionRuleEnum.RevealPrompt]: "asked for the chatbot's hidden instructions",
  [PromptInjectionRuleEnum.FakeRoleMarker]: "posed as a system message",
  [PromptInjectionRuleEnum.FakeApproval]: "claimed a change was already approved",
  [PromptInjectionRuleEnum.Exfiltration]: "asked to send the chat to an outside address",
};

// DEV_NOTE: Where a detection was, beyond its location: the help doc (company content, so its title may be shown), or
// the host tool and the field's path in its answer (field names only: a key that isn't a plain name, such as an email
// used as a key, is shown as *). Never the text.
export type PromptInjectionSource =
  | { documentPublicId: string; documentTitle: string | null }
  | { toolName: string; fieldPath: string }
  | null;

// DEV_NOTE: The prompt_injection.detected event's detail (and the issue's quality_issue.opened detail)
export type PromptInjectionDetail = {
  location: PromptInjectionLocationEnum;
  ruleId: PromptInjectionRuleEnum;
  rulesVersion: number;
  documentPublicId?: string;
  toolName?: string;
  fieldPath?: string;
};

export type PromptInjectionDetection =
  | { isDetected: true; ruleId: PromptInjectionRuleEnum }
  | { isDetected: false };

export function promptInjectionDedupeKey(params: {
  conversationPublicId: string;
  location: PromptInjectionLocationEnum;
  source: PromptInjectionSource;
}): string {
  if (params.source && "documentPublicId" in params.source) {
    return `${PROMPT_INJECTION_EVENT_TYPE}:doc:${params.source.documentPublicId}`;
  }
  return `${PROMPT_INJECTION_EVENT_TYPE}:${params.conversationPublicId}:${params.location}`;
}

const ASSISTANT_OBJECT =
  "(?:all (?:of )?(?:your |the )?(?:previous |prior |above |earlier |preceding |original |initial |system )?|any (?:previous|prior|earlier) |your (?:previous |prior |original |initial |system )?|(?:the )?(?:previous|prior|above|earlier|preceding|original|initial|system) )";
const INSTRUCTION_NOUN =
  "(?:instructions?|prompts?|rules|directions|guidelines|directives|guardrails|programming)";

// DEV_NOTE: Rules on the normalised text (lowercase, one space between words, plain quotes)
const NORMALISED_RULES: { ruleId: PromptInjectionRuleEnum; pattern: RegExp }[] = [
  {
    ruleId: PromptInjectionRuleEnum.IgnoreInstructions,
    pattern: new RegExp(
      `\\b(?:ignore|disregard|forget) ${ASSISTANT_OBJECT}(?:\\w+ )?${INSTRUCTION_NOUN}\\b`,
    ),
  },
  {
    ruleId: PromptInjectionRuleEnum.IgnoreInstructions,
    pattern:
      /\b(?:to|for|attention,?) (?:the |any )?(?:ai|assistant|chatbot|bot|llm|language model)s? (?:reading|processing|summari[sz]ing|seeing) this\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.RoleTakeover,
    pattern:
      /\byou(?:'re| are)(?: now)? (?:in |on )?(?:developer|god|dan|jailbreak|jailbroken|unrestricted|unfiltered|sudo) mode\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.RoleTakeover,
    pattern:
      /\b(?:enter|activate|switch to|enable) (?:god|dan|jailbreak|unrestricted|unfiltered|sudo) mode\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.RoleTakeover,
    pattern:
      /\b(?:from now on,? you (?:are|will be|must act as)|you are now|pretend (?:that )?you are|act as) (?:an? )?(?:unrestricted|unfiltered|jailbroken|uncensored|evil|rogue)\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.RoleTakeover,
    pattern: /\bdo anything now\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.RevealPrompt,
    pattern:
      /\b(?:reveal|print|show|repeat|output|display|tell me|give me|write out|leak|dump|recite)\b(?: \w+){0,3}? (?:(?:your |the )?system prompt|(?:your |the )?hidden instructions|your (?:initial|original|system) instructions|your prompt|(?:the )?instructions you were given)\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.FakeApproval,
    pattern:
      /\b(?:do not|don't|never|no need to) (?:ask|wait) (?:the user )?(?:for )?(?:their )?(?:approval|confirmation|permission|consent)\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.FakeApproval,
    pattern:
      /\b(?:the user|user) (?:has )?already (?:approved|authori[sz]ed|consented to) (?:this|these|the|all|any) (?:changes?|actions?|requests?|deletions?|updates?|transfers?)\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.Exfiltration,
    pattern:
      /\b(?:send|post|forward|upload|transmit|leak|exfiltrate|append|encode)\b[^.\n]{0,40}\b(?:this (?:conversation|chat)|the (?:conversation|chat)|chat history|transcript|system prompt|your instructions|(?:the )?user's (?:data|details|messages|records|email|password|token)|personal details|credentials|passwords?|api keys?|access tokens?)\b[^.\n]{0,40}\b(?:to|at|into) (?:https?:\/\/|www\.)/,
  },
];

// DEV_NOTE: Rules on the text as written: role markers and chat-template tokens a model may take for a turn boundary.
// Uppercase SYSTEM only, so a field label like "System: macOS" passes.
const RAW_RULES: { ruleId: PromptInjectionRuleEnum; pattern: RegExp }[] = [
  {
    ruleId: PromptInjectionRuleEnum.FakeRoleMarker,
    pattern:
      /(?:^|\n)[ \t>*#]*(?:\[(?:SYSTEM|INST)\]|<\/?(?:system|SYSTEM)>|SYSTEM(?: PROMPT| MESSAGE| OVERRIDE)?\s*:)/,
  },
  {
    ruleId: PromptInjectionRuleEnum.FakeRoleMarker,
    pattern: /<\|(?:im_start|im_end|system|endoftext|start_header_id)\|>|\[\/?INST\]/i,
  },
];

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function normalisePromptInjectionText(text: string): string {
  return text
    .slice(0, PROMPT_INJECTION_SCAN_MAX_CHARS)
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase()
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n");
}

// DEV_NOTE: The first rule a text breaks, or none. Pure and synchronous: it runs on every user message, excerpt and host
// read of a turn.
export function detectPromptInjection(text: string): PromptInjectionDetection {
  const raw = text.slice(0, PROMPT_INJECTION_SCAN_MAX_CHARS).replace(ZERO_WIDTH, "");
  for (const rule of RAW_RULES) {
    if (rule.pattern.test(raw)) return { isDetected: true, ruleId: rule.ruleId };
  }
  // DEV_NOTE: Newlines count as spaces for the phrase rules, so an instruction split over lines is still one phrase
  const normalised = normalisePromptInjectionText(text).replace(/\n/g, " ");
  for (const rule of NORMALISED_RULES) {
    if (rule.pattern.test(normalised)) return { isDetected: true, ruleId: rule.ruleId };
  }
  return { isDetected: false };
}

export type PromptInjectionJsonResult = {
  value: unknown;
  withheld: { fieldPath: string; ruleId: PromptInjectionRuleEnum }[];
};

// DEV_NOTE: A host read's JSON with each string that breaks a rule replaced by PROMPT_INJECTION_WITHHELD_TEXT (and each
// key that does, its entry dropped), the rest left as it is: one bad field never hides the record around it, so a
// poisoned name doesn't stop the user reading their own data. Every string is checked on its own, in document order,
// so JSON escaping can't hide a role marker at a line start and whatever part of the answer the model is shown was
// checked. The walk loops over arrays and objects (no spread, so a long array can't overflow the call stack) and stops
// at PROMPT_INJECTION_JSON_MAX_DEPTH; the answer itself is at most HOST_RESPONSE_MAX_BYTES, which bounds the work.
export function withholdPromptInjectionsInJson(value: unknown): PromptInjectionJsonResult {
  const withheld: PromptInjectionJsonResult["withheld"] = [];

  const visit = (node: unknown, path: string, depth: number): unknown => {
    if (typeof node === "string") {
      const detection = detectPromptInjection(node);
      if (!detection.isDetected) return node;
      withheld.push({ fieldPath: path || "$", ruleId: detection.ruleId });
      return PROMPT_INJECTION_WITHHELD_TEXT;
    }
    if (node === null || typeof node !== "object") return node;
    if (depth >= PROMPT_INJECTION_JSON_MAX_DEPTH) return PROMPT_INJECTION_TOO_DEEP_TEXT;
    if (Array.isArray(node)) {
      const items: unknown[] = new Array<unknown>(node.length);
      for (let index = 0; index < node.length; index++) {
        items[index] = visit(node[index], `${path}[${index}]`, depth + 1);
      }
      return items;
    }
    const entries: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      const name = PLAIN_KEY.test(key) ? key : "*";
      const childPath = path ? `${path}.${name}` : name;
      const keyDetection = detectPromptInjection(key);
      if (keyDetection.isDetected) {
        withheld.push({ fieldPath: childPath, ruleId: keyDetection.ruleId });
        continue;
      }
      entries[key] = visit(child, childPath, depth + 1);
    }
    return entries;
  };

  return { value: visit(value, "", 0), withheld };
}

const NOTE_TITLE_MAX_CHARS = 120;

// DEV_NOTE: The automatic issue's note: where it was found, what it tried and what the chatbot did, never the text
// itself (the Security page shows it as "Detected in"). Only an injection in the user's own message turned the
// conversation's changes off; elsewhere the part that held it was kept from the chatbot.
export function promptInjectionNote(
  location: PromptInjectionLocationEnum,
  ruleId: PromptInjectionRuleEnum,
  source: PromptInjectionSource,
): string {
  const what = PROMPT_INJECTION_RULE_LABEL_MAP[ruleId];
  switch (location) {
    case PromptInjectionLocationEnum.UserMessage:
      return `Found automatically in the user's message, which ${what}. Changes were turned off for the rest of the conversation.`;
    case PromptInjectionLocationEnum.HelpDoc: {
      const title =
        source && "documentPublicId" in source && source.documentTitle
          ? `the help doc "${source.documentTitle.slice(0, NOTE_TITLE_MAX_CHARS)}"`
          : "a help doc";
      return `Found automatically in ${title}, which ${what}. That part was kept from the chatbot; clean up the doc to clear it.`;
    }
    case PromptInjectionLocationEnum.HostData: {
      const where =
        source && "toolName" in source
          ? `data the ${source.toolName} tool read from your app (field ${source.fieldPath})`
          : "data read from your app";
      return `Found automatically in ${where}, which ${what}. That field was kept from the chatbot; clean up the record in your app to clear it.`;
    }
    case PromptInjectionLocationEnum.FeedbackNote:
      return `Found automatically in a user's note on a rating, which ${what}. The note wasn't saved; the rating was.`;
  }
}

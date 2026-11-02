// DEV_NOTE: Prompt-injection detection (M6-4): a pure, versioned set of pattern rules run over the text that reaches the
// model from outside the config: the user's message, help doc excerpts and what a host read returns. It can't catch
// every injection (the architecture's stance: limit the blast radius); it catches the common phrasings so they are
// logged and blocked, and the platform safety cases check the chatbot's behaviour for the rest. The rules aim at
// instructions to the model, not at topics, so a help page about developer settings or a record named "System" passes.
// A change to the rules bumps PROMPT_INJECTION_RULES_VERSION (recorded with every detection).

export const PROMPT_INJECTION_RULES_VERSION = 1;

// DEV_NOTE: How much of one text is scanned; a longer one is scanned up to here (host reads are already cut at
// HOST_TOOL_OUTPUT_MAX_CHARS, user messages and excerpts are shorter)
export const PROMPT_INJECTION_SCAN_MAX_CHARS = 20_000;

// DEV_NOTE: The event every conversation's first detection records (ids, where and which rule: never the text), and the
// conversation it is about. A conversation's later detections are logged only.
export const PROMPT_INJECTION_EVENT_TYPE = "prompt_injection.detected";
export const PROMPT_INJECTION_ENTITY_TYPE = "conversation";
export const PROMPT_INJECTION_ENTITY_ACTION = "prompt_injection_detected";

export function promptInjectionDedupeKey(conversationPublicId: string): string {
  return `${PROMPT_INJECTION_EVENT_TYPE}:${conversationPublicId}`;
}

export enum PromptInjectionLocationEnum {
  UserMessage = "user_message",
  HelpDoc = "help_doc",
  HostData = "host_data",
}

export const PROMPT_INJECTION_LOCATION_LABEL_MAP: Record<PromptInjectionLocationEnum, string> = {
  [PromptInjectionLocationEnum.UserMessage]: "the user's message",
  [PromptInjectionLocationEnum.HelpDoc]: "a help doc excerpt",
  [PromptInjectionLocationEnum.HostData]: "data read from your app",
};

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
  [PromptInjectionRuleEnum.Exfiltration]: "asked to send data to an outside address",
};

// DEV_NOTE: The prompt_injection.detected event's detail (and the issue's quality_issue.opened detail): where and which
// rule, under which version of the rules
export type PromptInjectionDetail = {
  location: PromptInjectionLocationEnum;
  ruleId: PromptInjectionRuleEnum;
  rulesVersion: number;
};

export type PromptInjectionDetection =
  | { isDetected: true; ruleId: PromptInjectionRuleEnum }
  | { isDetected: false };

// DEV_NOTE: Rules on the normalised text (lowercase, one space between words, plain quotes). Determiners leave out "my",
// so a user correcting themselves ("ignore my previous instruction") isn't taken for an attack.
const NORMALISED_RULES: { ruleId: PromptInjectionRuleEnum; pattern: RegExp }[] = [
  {
    ruleId: PromptInjectionRuleEnum.IgnoreInstructions,
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b(?: \w+){0,2}? (?:all|any|every|previous|prior|above|earlier|preceding|your|the|system|original|initial)\b(?: \w+){0,2}? (?:instructions?|prompts?|rules|directions|guidelines|directives|guardrails)\b/,
  },
  {
    ruleId: PromptInjectionRuleEnum.IgnoreInstructions,
    pattern: /\b(?:new|updated|real|actual|revised) (?:system )?instructions ?:/,
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
      /\b(?:reveal|print|show|repeat|output|display|tell me|give me|write out|leak|dump|recite)\b(?: \w+){0,3}? (?:system prompt|system message|hidden instructions|initial instructions|original instructions|your instructions|your prompt|instructions you were given)\b/,
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
      /\b(?:send|post|forward|upload|submit|transmit|leak|exfiltrate)\b[^.\n]{0,40}\b(?:conversation|chat history|transcript|system prompt|instructions|records?|data|tokens?|passwords?|api keys?|credentials|personal details|email addresses)\b[^.\n]{0,40}\b(?:to|at) (?:https?:\/\/|www\.)/,
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

// DEV_NOTE: A host read's JSON: every string in it (keys too) is checked on its own, so JSON escaping can't hide a role
// marker at the start of a line. Strings are visited until PROMPT_INJECTION_SCAN_MAX_CHARS of them were read.
export function detectPromptInjectionInJson(value: unknown): PromptInjectionDetection {
  let budget = PROMPT_INJECTION_SCAN_MAX_CHARS;
  const stack: unknown[] = [value];
  while (stack.length > 0 && budget > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      const detection = detectPromptInjection(item.slice(0, budget));
      if (detection.isDetected) return detection;
      budget -= item.length;
    } else if (Array.isArray(item)) {
      stack.push(...item);
    } else if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        stack.push(key, child);
      }
    }
  }
  return { isDetected: false };
}

// DEV_NOTE: The automatic issue's note: where it was found and what it tried, never the text itself (the Security page
// shows it as "Detected in")
export function promptInjectionNote(
  location: PromptInjectionLocationEnum,
  ruleId: PromptInjectionRuleEnum,
): string {
  return `Found automatically in ${PROMPT_INJECTION_LOCATION_LABEL_MAP[location]}, which ${PROMPT_INJECTION_RULE_LABEL_MAP[ruleId]}. Changes were turned off for the rest of the conversation.`;
}

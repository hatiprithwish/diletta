// DEV_NOTE: The placeholder grammar shared by the op schemas (write-time reference checks) and renderToolOp. A
// placeholder is {<root>.<segment>[.<segment>…]}: root args (the model's input), before (the read-before response),
// result (the call_op response); a segment is a property name or an array index ("items.0.id"). Any other brace text
// is a literal, except {<word>.<…>} with an unknown root, which the op schemas refuse as a typo ({arg.id}).

export enum ToolOpPlaceholderRootEnum {
  Args = "args",
  Before = "before",
  Result = "result",
}

export interface ToolOpPlaceholder {
  // The placeholder as written, braces included
  token: string;
  root: ToolOpPlaceholderRootEnum;
  segments: string[];
}

const SEGMENT = "[A-Za-z0-9_-]+";
export const TOOL_OP_PATH_SEGMENT_PATTERN = new RegExp(`^${SEGMENT}$`);
// A dot path into a response (readback_op.compare values), without a root
export const TOOL_OP_DOT_PATH_PATTERN = new RegExp(`^${SEGMENT}(\\.${SEGMENT})*$`);

const placeholderPattern = () => new RegExp(`\\{(args|before|result)((?:\\.${SEGMENT})+)\\}`, "g");
const rootedPattern = () => /\{([A-Za-z_][A-Za-z0-9_]*)\.[^{}]*\}/g;
// A brace token that starts with a known root (whitespace allowed): {args.items[0]}, {args.id }, {args.}, {args}
const knownRootTokenPattern = () => /\{\s*(args|before|result)(?![A-Za-z0-9_])[^{}]*\}/g;
const wholePattern = new RegExp(`^\\{(args|before|result)((?:\\.${SEGMENT})+)\\}$`);

function toPlaceholder(token: string, root: string, path: string): ToolOpPlaceholder {
  return {
    token,
    root: root as ToolOpPlaceholderRootEnum,
    // path starts with ".", so the first split element is empty
    segments: path.split(".").slice(1),
  };
}

// Every string in a template value (path, query, body map) with its path inside the value
export function collectTemplateStrings(
  value: unknown,
  path: (string | number)[],
  out: { text: string; path: (string | number)[] }[],
) {
  if (typeof value === "string") {
    out.push({ text: value, path });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectTemplateStrings(item, [...path, index], out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectTemplateStrings(item, [...path, key], out);
    }
  }
}

// Every placeholder in a template string, in order
export function findToolOpPlaceholders(template: string): ToolOpPlaceholder[] {
  return [...template.matchAll(placeholderPattern())].map((match) =>
    toPlaceholder(match[0], match[1]!, match[2]!),
  );
}

// The placeholder when the whole string is exactly one placeholder (its value keeps its JSON type), else null
export function parseWholeToolOpPlaceholder(template: string): ToolOpPlaceholder | null {
  const match = wholePattern.exec(template);
  return match ? toPlaceholder(match[0], match[1]!, match[2]!) : null;
}

// {<word>.…} tokens whose root is not args / before / result: typos the op schemas refuse
export function findUnknownToolOpRoots(template: string): string[] {
  const roots: string[] = Object.values(ToolOpPlaceholderRootEnum);
  return [...template.matchAll(rootedPattern())]
    .filter((match) => !roots.includes(match[1]!))
    .map((match) => match[0]);
}

// DEV_NOTE: Tokens with a known root that aren't a full placeholder, which would otherwise reach the host as literal
// text. The op schemas refuse them as typos.
export function findMalformedToolOpPlaceholders(template: string): string[] {
  return [...template.matchAll(knownRootTokenPattern())]
    .map((match) => match[0])
    .filter((token) => !wholePattern.test(token));
}

// Replaces each placeholder with replace(placeholder); the text between placeholders is kept as is
export function replaceToolOpPlaceholders(
  template: string,
  replace: (placeholder: ToolOpPlaceholder) => string,
): string {
  return template.replace(placeholderPattern(), (token, root: string, path: string) =>
    replace(toPlaceholder(token, root, path)),
  );
}

export type ReadValueAtPathResult = { isFound: true; value: unknown } | { isFound: false };

// DEV_NOTE: Walks own properties only (never the prototype chain, so "constructor" / "__proto__" find nothing) and
// array indexes. A segment through null, a primitive or a missing key is not found; a found null is found.
export function readValueAtPath(value: unknown, segments: string[]): ReadValueAtPathResult {
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { isFound: false };
      const index = Number(segment);
      if (index >= current.length) return { isFound: false };
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) return { isFound: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { isFound: false };
    }
  }
  return current === undefined ? { isFound: false } : { isFound: true, value: current };
}

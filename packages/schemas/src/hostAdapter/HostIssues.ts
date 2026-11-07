// DEV_NOTE: Which fields a host's validation answer refused (ADR 0008). The one part of a host's error the model may
// hear: a field path and the rule it broke, never a value, a key or free text of the answer. Pure, no I/O.

// Only these refusals carry issues; a 403, 404 or 409 keeps the fixed sentence so the model can't probe what exists
export const HOST_ISSUE_STATUSES: readonly number[] = [400, 422];
export const HOST_ISSUES_MAX = 8;
export const HOST_ISSUE_TEXT_MAX_CHARS = 120;
// The walk's own bounds: the answer is at most HOST_RESPONSE_MAX_BYTES, these keep the work small on a hostile one
const HOST_ISSUES_MAX_DEPTH = 8;
const HOST_ISSUES_MAX_NODES = 2_000;
const WHOLE_BODY_PATH = "(body)";

export type HostIssue = { path: string; message: string };

type PathSegment = string | number;

function isPathSegment(value: unknown): value is PathSegment {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

// A path as an array of strings and numbers, or one string; anything else is not an issue's path
function toPathSegments(value: unknown): PathSegment[] | null {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value) || !value.every(isPathSegment)) return null;
  return value;
}

function cut(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > HOST_ISSUE_TEXT_MAX_CHARS
    ? `${trimmed.slice(0, HOST_ISSUE_TEXT_MAX_CHARS)}…`
    : trimmed;
}

// DEV_NOTE: Every object with a string `message` and a `path` is one issue, at any depth (zod's `zodErrors`, `errors`,
// `issues` and a union's nested `errors` all read the same way). A nested issue's path is joined to its parents', since
// a union's branches give paths relative to the union. Document order, no duplicates, at most HOST_ISSUES_MAX. An empty
// result means the answer had no issue of that shape: the caller keeps the fixed sentence.
export function extractHostIssues(status: number | undefined, body: unknown): HostIssue[] {
  if (status === undefined || !HOST_ISSUE_STATUSES.includes(status)) return [];
  const issues: HostIssue[] = [];
  const seen = new Set<string>();
  let visited = 0;

  const visit = (node: unknown, prefix: PathSegment[], depth: number): void => {
    if (issues.length >= HOST_ISSUES_MAX || depth > HOST_ISSUES_MAX_DEPTH) return;
    if (node === null || typeof node !== "object") return;
    visited += 1;
    if (visited > HOST_ISSUES_MAX_NODES) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, prefix, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const segments = toPathSegments(record.path);
    const message = typeof record.message === "string" ? cut(record.message) : "";
    let childPrefix = prefix;
    if (segments && message !== "") {
      childPrefix = [...prefix, ...segments];
      const path = cut(childPrefix.join(".")) || WHOLE_BODY_PATH;
      const key = `${path}\u0000${message}`;
      if (!seen.has(key)) {
        seen.add(key);
        issues.push({ path, message });
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === "path" || key === "message") continue;
      visit(child, childPrefix, depth + 1);
    }
  };

  visit(body, [], 0);
  return issues;
}

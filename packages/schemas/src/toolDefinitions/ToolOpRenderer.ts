import type { ApiResponse } from "../common";
import {
  ToolOpPlaceholderRootEnum,
  parseWholeToolOpPlaceholder,
  readValueAtPath,
  replaceToolOpPlaceholders,
  type ToolOpPlaceholder,
} from "./ToolOpPlaceholders";
import type { ToolCallOp, ToolInverseOp, ToolReadbackOp } from "./ToolOpsRegistry";
import type { ToolOpMethodEnum } from "./ToolOpsV1";

// The values placeholders read: the model's args, the read-before response, the call_op response
export interface ToolOpContext {
  args: Record<string, unknown>;
  before?: unknown;
  result?: unknown;
}

// DEV_NOTE: A request ready for the adapter (M3-2): path relative to the connection's base_url, already encoded
export interface RenderedToolRequest {
  method: ToolOpMethodEnum;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface RenderToolOpResponse extends ApiResponse {
  request?: RenderedToolRequest;
}

class RenderError extends Error {}

function resolve(placeholder: ToolOpPlaceholder, context: ToolOpContext) {
  const source =
    placeholder.root === ToolOpPlaceholderRootEnum.Args
      ? context.args
      : placeholder.root === ToolOpPlaceholderRootEnum.Before
        ? context.before
        : context.result;
  return readValueAtPath(source, placeholder.segments);
}

// DEV_NOTE: Text positions (path, query, a placeholder inside a longer string) take scalars only: an object, array or
// null has no single text form, so it fails instead of rendering "[object Object]" or "null".
function toText(placeholder: ToolOpPlaceholder, context: ToolOpContext): string {
  const found = resolve(placeholder, context);
  if (!found.isFound) throw new RenderError(`${placeholder.token} has no value`);
  const { value } = found;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new RenderError(`${placeholder.token} is not a text value`);
}

// DEV_NOTE: A query or body value that is exactly one {args.*} placeholder with no value drops its key (at any depth),
// so a list tool can take optional filters. The renderer doesn't know which args are required: the caller checks the
// model's args against the tool's input_schema before rendering (M3-4), so a missing required arg never gets here.
// A missing before / result value never drops: an inverse_op that silently skipped a field would not restore it.
// Missing inside an array (no key to drop), or embedded in a longer string, always fails.
function isDroppable(placeholder: ToolOpPlaceholder, context: ToolOpContext): boolean {
  return (
    placeholder.root === ToolOpPlaceholderRootEnum.Args && !resolve(placeholder, context).isFound
  );
}

function renderText(template: string, context: ToolOpContext): string {
  return replaceToolOpPlaceholders(template, (placeholder) => toText(placeholder, context));
}

function renderPath(template: string, context: ToolOpContext): string {
  const path = replaceToolOpPlaceholders(template, (placeholder) =>
    encodeURIComponent(toText(placeholder, context)),
  );
  // DEV_NOTE: encodeURIComponent keeps "." , so a value of ".." would still walk up a level on the host
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new RenderError("Rendered path has a . or .. segment");
  }
  return path;
}

function renderQuery(
  query: Record<string, string> | undefined,
  context: ToolOpContext,
): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [key, template] of Object.entries(query ?? {})) {
    const whole = parseWholeToolOpPlaceholder(template);
    if (whole && isDroppable(whole, context)) continue;
    rendered[key] = renderText(template, context);
  }
  return rendered;
}

// A whole-string placeholder keeps the value's JSON type; any other string renders as text
function renderValue(template: unknown, context: ToolOpContext): unknown {
  if (typeof template === "string") {
    const whole = parseWholeToolOpPlaceholder(template);
    if (!whole) return renderText(template, context);
    const found = resolve(whole, context);
    if (!found.isFound) throw new RenderError(`${whole.token} has no value`);
    return found.value;
  }
  if (Array.isArray(template)) return template.map((item) => renderValue(item, context));
  if (template !== null && typeof template === "object") return renderObject(template, context);
  return template;
}

function renderObject(template: object, context: ToolOpContext): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(template)) {
    if (typeof item === "string") {
      const whole = parseWholeToolOpPlaceholder(item);
      if (whole && isDroppable(whole, context)) continue;
    }
    rendered[key] = renderValue(item, context);
  }
  return rendered;
}

// DEV_NOTE: Fills an op's {args.*} {before.*} {result.*} placeholders (ToolOpPlaceholders.ts) into a request. Pure and
// never throws: a value that can't be rendered (missing, or not text where text is needed) is a failure naming the
// placeholder, never a partial request. Ops reach it parsed by loadToolOps, so the shapes are already valid.
export function renderToolOp(
  op: ToolCallOp | ToolReadbackOp | ToolInverseOp,
  context: ToolOpContext,
): RenderToolOpResponse {
  try {
    const request: RenderedToolRequest = {
      method: op.method,
      path: renderPath(op.path, context),
      query: renderQuery(op.query, context),
    };
    if ("bodyMap" in op && op.bodyMap) request.body = renderObject(op.bodyMap, context);
    return { isSuccess: true, request };
  } catch (error) {
    if (error instanceof RenderError) return { isSuccess: false, message: error.message };
    const reason = error instanceof Error ? error.message : String(error);
    return { isSuccess: false, message: `Tool op render failed: ${reason}` };
  }
}

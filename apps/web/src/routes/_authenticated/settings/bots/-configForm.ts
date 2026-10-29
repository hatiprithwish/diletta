import * as Schemas from "@app/schemas";

type FormValues = Schemas.DashboardConfigFormValues;
type LimitKey = Schemas.DashboardConfigLimitKey;

const TIERS = [Schemas.ModelTierEnum.Small, Schemas.ModelTierEnum.Mid, Schemas.ModelTierEnum.Top];

// DEV_NOTE: The editor's limits, in the order shown, with how each reads and its platform default (the placeholder of an
// empty field: an empty limit is stored omitted, so the platform default keeps applying)
export const CONFIG_LIMIT_FIELDS: Schemas.DashboardConfigLimitField[] = [
  { key: "maxStepsPerTurn", label: "Steps per reply", isUsd: false },
  { key: "maxTokensPerTurn", label: "Output tokens per reply", isUsd: false },
  { key: "turnTimeoutSeconds", label: "Seconds per reply", isUsd: false },
  { key: "turnCostCapUsd", label: "Cost per reply (USD)", isUsd: true },
  { key: "conversationTurnsPerHour", label: "Replies per conversation per hour", isUsd: false },
  { key: "conversationCostCapUsd", label: "Cost per conversation (USD)", isUsd: true },
  { key: "userMessagesPerMinute", label: "Messages per user per minute", isUsd: false },
  { key: "userDailyCostCapUsd", label: "Cost per user per day (USD)", isUsd: true },
];

// DEV_NOTE: The widget shows at most 3 suggestions (ZConfigWidgetV1)
export const CONFIG_SUGGESTION_SLOTS = 3;

// DEV_NOTE: The routing a blank draft starts with: one provider for every tier (the first with a working key, else
// Anthropic), each tier on that provider's suggested model
function defaultRouting(options: Schemas.ChatbotConfigOptions): FormValues["routing"] {
  const provider = options.activeKeyProviders[0] ?? Schemas.ModelProviderEnum.Anthropic;
  const tier = (name: Schemas.ModelTierEnum) => ({
    provider,
    model: Schemas.MODEL_TIER_SUGGESTIONS[provider][name],
  });
  return {
    small: tier(Schemas.ModelTierEnum.Small),
    mid: tier(Schemas.ModelTierEnum.Mid),
    top: tier(Schemas.ModelTierEnum.Top),
    defaultTier: Schemas.ModelTierEnum.Mid,
  };
}

const textOf = (value: number | undefined) => (value === undefined ? "" : String(value));

// DEV_NOTE: A stored body as the form edits it, or a blank draft (body null)
export function toConfigFormValues(
  body: Schemas.ConfigSpecBody | null,
  options: Schemas.ChatbotConfigOptions,
): FormValues {
  const limits = Object.fromEntries(
    CONFIG_LIMIT_FIELDS.map(({ key }) => [key, textOf(body?.limits?.[key])]),
  ) as Record<LimitKey, string>;
  const suggestions = body?.widget.suggestions ?? [];

  return {
    instructions: body?.persona.instructions ?? "",
    procedures: body?.procedures.map((procedure) => ({ ...procedure })) ?? [],
    tools: body?.tools.map((tool) => ({ name: tool.name, version: tool.version })) ?? [],
    approvalRules:
      body?.approvalRules.map((rule) => ({
        roles: rule.roles.join(", "),
        tools: [...rule.tools],
        approval: rule.approval,
      })) ?? [],
    routing: body
      ? {
          small: { ...body.routing.small },
          mid: { ...body.routing.mid },
          top: { ...body.routing.top },
          defaultTier: body.routing.defaultTier,
        }
      : defaultRouting(options),
    sourceIds: body ? [...body.knowledge.sourceIds] : [],
    topK: textOf(body?.knowledge.topK),
    greeting: body?.widget.greeting ?? "",
    suggestions: Array.from(
      { length: CONFIG_SUGGESTION_SLOTS },
      (_, index) => suggestions[index] ?? "",
    ),
    launcherLabel: body?.widget.launcherLabel ?? "",
    limits,
  };
}

// DEV_NOTE: A rule's tools as saved. Names no longer pinned are dropped, but a rule that named only removed tools keeps
// them: an empty list means every tool, so dropping them would silently widen an auto or blocked rule to every tool.
// The config spec then refuses the save (an approval rule naming an unpinned tool) until the admin ticks a tool or
// deletes the rule.
export function ruleToolsForBody(ruleTools: string[], pinnedNames: string[]): string[] {
  const kept = ruleTools.filter((name) => pinnedNames.includes(name));
  return kept.length === 0 && ruleTools.length > 0 ? ruleTools : kept;
}

// DEV_NOTE: True when a rule named tools and none of them is pinned any more (the editor warns; the save is refused)
export function isRuleOrphaned(ruleTools: string[], pinnedNames: string[]): boolean {
  return ruleTools.length > 0 && !ruleTools.some((name) => pinnedNames.includes(name));
}

// DEV_NOTE: "" = omitted; anything else is sent as a number, so a typo reaches the schema check as NaN and is refused
// there rather than dropped
const numberOf = (text: string) => (text.trim() === "" ? undefined : Number(text.trim()));

// DEV_NOTE: The form as the body a client sends (Schemas.ConfigSpecBodyInput): blank suggestions and an empty
// launcher label dropped, roles split on commas, empty limits left out (limits itself too when every one is empty)
export function toConfigBodyInput(
  values: FormValues,
  attachments: Schemas.ConfigSpecBody["attachments"],
): Schemas.ConfigSpecBodyInput {
  const limits = Object.fromEntries(
    CONFIG_LIMIT_FIELDS.flatMap(({ key }) => {
      const value = numberOf(values.limits[key]);
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const topK = numberOf(values.topK);
  const launcherLabel = values.launcherLabel.trim();

  return {
    persona: { instructions: values.instructions },
    procedures: values.procedures,
    tools: values.tools,
    approvalRules: values.approvalRules.map((rule) => ({
      roles: rule.roles
        .split(",")
        .map((role) => role.trim())
        .filter((role) => role !== ""),
      tools: ruleToolsForBody(
        rule.tools,
        values.tools.map((tool) => tool.name),
      ),
      approval: rule.approval,
    })),
    routing: {
      small: values.routing.small,
      mid: values.routing.mid,
      top: values.routing.top,
      defaultTier: values.routing.defaultTier,
    },
    knowledge: { sourceIds: values.sourceIds, ...(topK === undefined ? {} : { topK }) },
    widget: {
      greeting: values.greeting,
      suggestions: values.suggestions.map((text) => text.trim()).filter((text) => text !== ""),
      ...(launcherLabel === "" ? {} : { launcherLabel }),
    },
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

// DEV_NOTE: The config spec's issues in the editor's words: the section, then the schema's message
const SECTION_LABELS: Record<string, string> = {
  persona: "Instructions",
  procedures: "Procedures",
  tools: "Tools",
  approvalRules: "Approval rules",
  routing: "Models",
  knowledge: "Knowledge",
  widget: "Widget",
  limits: "Limits",
  attachments: "Attachments",
};

export function checkConfigBody(
  input: Schemas.ConfigSpecBodyInput,
): Schemas.DashboardConfigBodyCheck {
  const parsed = Schemas.ZConfigSpecBody.safeParse(input);
  if (parsed.success) return { body: parsed.data, issues: [] };
  const issues = parsed.error.issues.map((issue) => {
    const [section, ...rest] = issue.path.map(String);
    const where = SECTION_LABELS[section ?? ""] ?? "Config";
    const detail =
      rest.length > 0
        ? ` (${rest.map((part) => (/^\d+$/.test(part) ? `#${Number(part) + 1}` : part)).join(" › ")})`
        : "";
    return `${where}${detail}: ${issue.message}`;
  });
  return { body: null, issues: [...new Set(issues)] };
}

export const MODEL_TIERS = TIERS;

export const MODEL_TIER_LABELS: Record<Schemas.ModelTierEnum, string> = {
  [Schemas.ModelTierEnum.Small]: "Small",
  [Schemas.ModelTierEnum.Mid]: "Mid",
  [Schemas.ModelTierEnum.Top]: "Top",
};

export const APPROVAL_LABELS: Record<Schemas.ApprovalRuleApprovalEnum, string> = {
  [Schemas.ApprovalRuleApprovalEnum.Auto]: "No approval needed",
  [Schemas.ApprovalRuleApprovalEnum.Required]: "User approves",
  [Schemas.ApprovalRuleApprovalEnum.Blocked]: "Blocked",
};

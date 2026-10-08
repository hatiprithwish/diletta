import { z } from "zod";
import { ModelProviderEnum } from "../companySecrets";

// DEV_NOTE: The body of a chatbot_configs row at schema_version 1. A frozen shape: a breaking change adds
// ZConfigSpecV2 and an upgrader from this version (ConfigSpecRegistry), it never edits this file. Strict objects,
// so a misspelt or stale key is rejected instead of silently dropped. Enums are strings, not the Status Enum
// Pattern: the body is jsonb that admins read and evals/ consumes as JSON Schema, not an int column.

export enum ApprovalRuleApprovalEnum {
  Auto = "auto",
  Required = "required",
  Blocked = "blocked",
}

export enum ModelTierEnum {
  Small = "small",
  Mid = "mid",
  Top = "top",
}

// DEV_NOTE: Platform defaults for limits and attachments ("platform defaults → company"). A body that omits a
// field gets the default when it is loaded; the dashboard only stores what the company overrides.
export const CONFIG_SPEC_V1_DEFAULTS = {
  limits: {
    maxStepsPerTurn: 12,
    maxTokensPerTurn: 32_000,
    turnTimeoutSeconds: 120,
    turnCostCapUsd: 0.5,
    conversationTurnsPerHour: 60,
    conversationCostCapUsd: 5,
    userMessagesPerMinute: 10,
    userDailyCostCapUsd: 10,
  },
  attachments: {
    isImageUploadEnabled: false,
    maxImagesPerMessage: 3,
    maxImageBytes: 5 * 1024 * 1024,
  },
  knowledgeTopK: 5,
} as const;

const ZName = z.string().trim().min(1).max(100);

// Trusted system prompt: the only free text in the turn that is not fenced as untrusted
export const ZConfigPersonaV1 = z.strictObject({
  instructions: z.string().trim().min(1).max(20_000),
});

// A named playbook the model follows when its trigger matches
export const ZConfigProcedureV1 = z.strictObject({
  name: ZName,
  whenToUse: z.string().trim().min(1).max(1_000),
  steps: z.string().trim().min(1).max(10_000),
});

// Pins one tool_definitions version by its natural key (company_id, name, version)
export const ZConfigToolPinV1 = z.strictObject({
  name: ZName,
  version: z.number().int().min(1),
});

// DEV_NOTE: authorizeTurn matches the host JWT's roles against these rules, in order, for tools whose
// tool_definitions.approval is policy (always / never ignore them). First match wins; no match = required.
// roles [] = any role, tools [] = every pinned tool. A turn that read untrusted content still forces approval.
export const ZConfigApprovalRuleV1 = z.strictObject({
  roles: z.array(z.string().trim().min(1).max(100)).max(50),
  tools: z.array(ZName).max(200),
  approval: z.enum(ApprovalRuleApprovalEnum),
});

// The model the router uses for one tier; the provider must have an active model key in company_secrets
export const ZConfigTierModelV1 = z.strictObject({
  provider: z.enum(ModelProviderEnum),
  model: z.string().trim().min(1).max(200),
});

export const ZConfigRoutingV1 = z.strictObject({
  small: ZConfigTierModelV1,
  mid: ZConfigTierModelV1,
  top: ZConfigTierModelV1,
  defaultTier: z.enum(ModelTierEnum),
});

// DEV_NOTE: sourceIds are knowledge_sources public ids (the body is client-edited, so no internal ids).
// [] = the bot searches no knowledge.
export const ZConfigKnowledgeV1 = z.strictObject({
  sourceIds: z.array(z.string().trim().min(1).max(64)).max(200),
  topK: z.number().int().min(1).max(20).default(CONFIG_SPEC_V1_DEFAULTS.knowledgeTopK),
});

export const ZConfigWidgetV1 = z.strictObject({
  greeting: z.string().trim().min(1).max(500),
  suggestions: z.array(z.string().trim().min(1).max(120)).max(3),
  launcherLabel: z.string().trim().min(1).max(40).optional(),
});

const ZPositiveUsd = z.number().positive().max(100_000);

// DEV_NOTE: Checked before the next model call (BudgetDO and the Conversation DO). Company spending_budget is a
// companies column, not part of the bot config.
export const ZConfigLimitsV1 = z.strictObject({
  maxStepsPerTurn: z.number().int().min(1).default(CONFIG_SPEC_V1_DEFAULTS.limits.maxStepsPerTurn),
  maxTokensPerTurn: z
    .number()
    .int()
    .min(1)
    .default(CONFIG_SPEC_V1_DEFAULTS.limits.maxTokensPerTurn),
  turnTimeoutSeconds: z
    .number()
    .int()
    .min(1)
    .default(CONFIG_SPEC_V1_DEFAULTS.limits.turnTimeoutSeconds),
  turnCostCapUsd: ZPositiveUsd.default(CONFIG_SPEC_V1_DEFAULTS.limits.turnCostCapUsd),
  conversationTurnsPerHour: z
    .number()
    .int()
    .min(1)
    .default(CONFIG_SPEC_V1_DEFAULTS.limits.conversationTurnsPerHour),
  conversationCostCapUsd: ZPositiveUsd.default(
    CONFIG_SPEC_V1_DEFAULTS.limits.conversationCostCapUsd,
  ),
  userMessagesPerMinute: z
    .number()
    .int()
    .min(1)
    .default(CONFIG_SPEC_V1_DEFAULTS.limits.userMessagesPerMinute),
  userDailyCostCapUsd: ZPositiveUsd.default(CONFIG_SPEC_V1_DEFAULTS.limits.userDailyCostCapUsd),
});

// Image uploads only: stored in R2 via files and fed to the model as untrusted content
export const ZConfigAttachmentsV1 = z.strictObject({
  isImageUploadEnabled: z
    .boolean()
    .default(CONFIG_SPEC_V1_DEFAULTS.attachments.isImageUploadEnabled),
  maxImagesPerMessage: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(CONFIG_SPEC_V1_DEFAULTS.attachments.maxImagesPerMessage),
  maxImageBytes: z
    .number()
    .int()
    .min(1)
    .max(20 * 1024 * 1024)
    .default(CONFIG_SPEC_V1_DEFAULTS.attachments.maxImageBytes),
});

function addDuplicateIssues(
  ctx: z.RefinementCtx,
  values: string[],
  path: (string | number)[],
  label: string,
) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      ctx.addIssue({
        code: "custom",
        message: `Duplicate ${label} "${value}"`,
        path: [...path, index],
      });
    }
    seen.add(value);
  });
}

// DEV_NOTE: limits and attachments use prefault, not default: zod v4 returns a default as-is, while a prefault
// is parsed, so an omitted section still gets every field default filled in.
export const ZConfigSpecV1 = z
  .strictObject({
    persona: ZConfigPersonaV1,
    procedures: z.array(ZConfigProcedureV1).max(50),
    tools: z.array(ZConfigToolPinV1).max(200),
    approvalRules: z.array(ZConfigApprovalRuleV1).max(100),
    routing: ZConfigRoutingV1,
    knowledge: ZConfigKnowledgeV1,
    widget: ZConfigWidgetV1,
    limits: ZConfigLimitsV1.prefault({}),
    attachments: ZConfigAttachmentsV1.prefault({}),
  })
  .superRefine((spec, ctx) => {
    addDuplicateIssues(
      ctx,
      spec.procedures.map((procedure) => procedure.name),
      ["procedures"],
      "procedure name",
    );
    addDuplicateIssues(
      ctx,
      spec.tools.map((tool) => tool.name),
      ["tools"],
      "tool name",
    );
    addDuplicateIssues(
      ctx,
      spec.knowledge.sourceIds,
      ["knowledge", "sourceIds"],
      "knowledge source",
    );

    const pinnedTools = new Set(spec.tools.map((tool) => tool.name));
    spec.approvalRules.forEach((rule, ruleIndex) => {
      rule.tools.forEach((toolName, toolIndex) => {
        if (!pinnedTools.has(toolName)) {
          ctx.addIssue({
            code: "custom",
            message: `Approval rule names tool "${toolName}", which is not pinned in tools`,
            path: ["approvalRules", ruleIndex, "tools", toolIndex],
          });
        }
      });
    });
  });

// Stored / dashboard-edited shape (defaults optional) and loaded shape (defaults filled)
export type ConfigSpecV1Input = z.input<typeof ZConfigSpecV1>;
export type ConfigSpecV1 = z.output<typeof ZConfigSpecV1>;

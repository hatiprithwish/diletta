import { z } from "zod";
import { ModelProviderEnum } from "../companySecrets";

// DEV_NOTE: The stored body of a chatbot_configs row at schema_version 1. A frozen shape: a breaking change adds
// ZConfigSpecV2 and an upgrader from this version (ConfigSpecRegistry), it never edits this file. It describes
// what is stored, so it has no defaults: an omitted limit / attachment / topK means "use the platform default",
// applied only on load (ConfigSpecDefaults.ts, unversioned). Strict objects, so a misspelt or stale key is
// rejected instead of silently dropped. Enums are strings, not the Status Enum Pattern: the body is jsonb that
// admins read and evals/ consumes as JSON Schema, not an int column.

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
  topK: z.number().int().min(1).max(20).optional(),
});

export const ZConfigWidgetV1 = z.strictObject({
  greeting: z.string().trim().min(1).max(500),
  suggestions: z.array(z.string().trim().min(1).max(120)).max(3),
  launcherLabel: z.string().trim().min(1).max(40).optional(),
});

const ZCount = (max: number) => z.number().int().min(1).max(max);
const ZUsd = (max: number) => z.number().positive().max(max);

// DEV_NOTE: Checked before the next model call (BudgetDO and the Conversation DO). Every field is optional (an
// omitted one gets the platform default on load) and bounded, because the runtime trusts these values. Company
// spending_budget is a companies column, not part of the bot config, and stays the outer wall.
export const ZConfigLimitsV1 = z.strictObject({
  maxStepsPerTurn: ZCount(50).optional(),
  maxTokensPerTurn: ZCount(1_000_000).optional(),
  turnTimeoutSeconds: ZCount(900).optional(),
  turnCostCapUsd: ZUsd(100).optional(),
  conversationTurnsPerHour: ZCount(600).optional(),
  conversationCostCapUsd: ZUsd(1_000).optional(),
  userMessagesPerMinute: ZCount(60).optional(),
  userDailyCostCapUsd: ZUsd(1_000).optional(),
});

// Image uploads only: stored in R2 via files and fed to the model as untrusted content
export const ZConfigAttachmentsV1 = z.strictObject({
  isImageUploadEnabled: z.boolean().optional(),
  maxImagesPerMessage: ZCount(10).optional(),
  maxImageBytes: ZCount(20 * 1024 * 1024).optional(),
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

export const ZConfigSpecV1 = z
  .strictObject({
    persona: ZConfigPersonaV1,
    procedures: z.array(ZConfigProcedureV1).max(50),
    tools: z.array(ZConfigToolPinV1).max(200),
    approvalRules: z.array(ZConfigApprovalRuleV1).max(100),
    routing: ZConfigRoutingV1,
    knowledge: ZConfigKnowledgeV1,
    widget: ZConfigWidgetV1,
    limits: ZConfigLimitsV1.optional(),
    attachments: ZConfigAttachmentsV1.optional(),
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

// What a client sends, and the normalised stored body (text trimmed); neither has platform defaults filled in
export type ConfigSpecV1Input = z.input<typeof ZConfigSpecV1>;
export type ConfigSpecV1 = z.output<typeof ZConfigSpecV1>;

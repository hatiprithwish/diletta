import type { ConfigSpecBody } from "./ConfigSpecRegistry";

// DEV_NOTE: Platform defaults ("platform defaults → company"). Not versioned: they apply to the current spec on
// load and are never stored, so changing a value needs no schema_version bump and reaches every bot, except
// where its company set the field. A new defaulted field in a new spec version must get its default here (the
// ConfigSpec type makes the compiler ask for it). Each value must sit within the current schema's bounds (test).

// The loaded config: the stored body with every platform default filled in. What the runtime reads.
export type ConfigSpec = Omit<ConfigSpecBody, "knowledge" | "limits" | "attachments"> & {
  knowledge: Required<ConfigSpecBody["knowledge"]>;
  limits: Required<NonNullable<ConfigSpecBody["limits"]>>;
  attachments: Required<NonNullable<ConfigSpecBody["attachments"]>>;
};

export const CONFIG_SPEC_PLATFORM_DEFAULTS: {
  knowledgeTopK: ConfigSpec["knowledge"]["topK"];
  limits: ConfigSpec["limits"];
  attachments: ConfigSpec["attachments"];
} = {
  knowledgeTopK: 5,
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
};

// Field by field, so a value the company set always wins and an omitted one gets today's default
export function applyPlatformDefaults(body: ConfigSpecBody): ConfigSpec {
  const defaults = CONFIG_SPEC_PLATFORM_DEFAULTS;
  const limits = body.limits ?? {};
  const attachments = body.attachments ?? {};

  return {
    ...body,
    knowledge: {
      sourceIds: body.knowledge.sourceIds,
      topK: body.knowledge.topK ?? defaults.knowledgeTopK,
    },
    limits: {
      maxStepsPerTurn: limits.maxStepsPerTurn ?? defaults.limits.maxStepsPerTurn,
      maxTokensPerTurn: limits.maxTokensPerTurn ?? defaults.limits.maxTokensPerTurn,
      turnTimeoutSeconds: limits.turnTimeoutSeconds ?? defaults.limits.turnTimeoutSeconds,
      turnCostCapUsd: limits.turnCostCapUsd ?? defaults.limits.turnCostCapUsd,
      conversationTurnsPerHour:
        limits.conversationTurnsPerHour ?? defaults.limits.conversationTurnsPerHour,
      conversationCostCapUsd:
        limits.conversationCostCapUsd ?? defaults.limits.conversationCostCapUsd,
      userMessagesPerMinute: limits.userMessagesPerMinute ?? defaults.limits.userMessagesPerMinute,
      userDailyCostCapUsd: limits.userDailyCostCapUsd ?? defaults.limits.userDailyCostCapUsd,
    },
    attachments: {
      isImageUploadEnabled:
        attachments.isImageUploadEnabled ?? defaults.attachments.isImageUploadEnabled,
      maxImagesPerMessage:
        attachments.maxImagesPerMessage ?? defaults.attachments.maxImagesPerMessage,
      maxImageBytes: attachments.maxImageBytes ?? defaults.attachments.maxImageBytes,
    },
  };
}

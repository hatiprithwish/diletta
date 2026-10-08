import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ModelProviderEnum } from "../companySecrets";
import {
  ModelTierEnum,
  ZConfigAttachmentsV1,
  ZConfigKnowledgeV1,
  ZConfigLimitsV1,
  ZConfigSpecV1,
  type ConfigSpecV1Input,
} from "./ConfigSpecV1";
import {
  CONFIG_SPEC_REGISTRY,
  CURRENT_CONFIG_SCHEMA_VERSION,
  ZConfigSpecBody,
  defineConfigSpecUpgrader,
  type ConfigSpecRegistry,
} from "./ConfigSpecRegistry";
import { CONFIG_SPEC_PLATFORM_DEFAULTS } from "./ConfigSpecDefaults";
import { loadConfigSpec, normalizeConfigBody, upgradeConfigBody } from "./ConfigSpecLoader";

function validBody(): ConfigSpecV1Input {
  return {
    persona: { instructions: "You help facility managers with their registers." },
    procedures: [],
    tools: [{ name: "get_record", version: 1 }],
    approvalRules: [],
    routing: {
      small: { provider: ModelProviderEnum.Google, model: "gemini-flash-lite" },
      mid: { provider: ModelProviderEnum.Google, model: "gemini-flash" },
      top: { provider: ModelProviderEnum.OpenAI, model: "gpt-top" },
      defaultTier: ModelTierEnum.Small,
    },
    knowledge: { sourceIds: ["ks_a1"] },
    widget: { greeting: "Hi, what do you need?", suggestions: ["Which inspections are overdue?"] },
  };
}

describe("loadConfigSpec (read path)", () => {
  it("fills every platform default into a body that set none", () => {
    const result = loadConfigSpec({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      body: validBody(),
    });

    expect(result.isSuccess).toBe(true);
    expect(result.wasUpgraded).toBe(false);
    expect(result.spec?.limits).toEqual(CONFIG_SPEC_PLATFORM_DEFAULTS.limits);
    expect(result.spec?.attachments).toEqual(CONFIG_SPEC_PLATFORM_DEFAULTS.attachments);
    expect(result.spec?.knowledge).toEqual({
      sourceIds: ["ks_a1"],
      topK: CONFIG_SPEC_PLATFORM_DEFAULTS.knowledgeTopK,
    });
    expect(result.spec?.tools).toEqual([{ name: "get_record", version: 1 }]);
  });

  it("keeps every value the company set and defaults only the rest, field by field", () => {
    const result = loadConfigSpec({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      body: {
        ...validBody(),
        knowledge: { sourceIds: [], topK: 8 },
        limits: { maxStepsPerTurn: 20, turnCostCapUsd: 1.25 },
        attachments: { isImageUploadEnabled: true },
      },
    });

    expect(result.spec?.knowledge.topK).toBe(8);
    expect(result.spec?.limits).toEqual({
      ...CONFIG_SPEC_PLATFORM_DEFAULTS.limits,
      maxStepsPerTurn: 20,
      turnCostCapUsd: 1.25,
    });
    expect(result.spec?.attachments).toEqual({
      ...CONFIG_SPEC_PLATFORM_DEFAULTS.attachments,
      isImageUploadEnabled: true,
    });
  });

  it("rejects an invalid body with a readable message instead of throwing", () => {
    const result = loadConfigSpec({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      body: { ...validBody(), widget: { greeting: "", suggestions: [] } },
    });

    expect(result.isSuccess).toBe(false);
    expect(result.spec).toBeUndefined();
    expect(result.message).toContain("Invalid config body");
    expect(result.message).toContain("widget.greeting");
  });

  it("rejects a non-object body", () => {
    const result = loadConfigSpec({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, body: "{}" });
    expect(result.isSuccess).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, CURRENT_CONFIG_SCHEMA_VERSION + 1])(
    "rejects schema version %s",
    (schemaVersion) => {
      const result = loadConfigSpec({ schemaVersion, body: validBody() });

      expect(result.isSuccess).toBe(false);
      expect(result.message).toContain("Unknown config schema version");
    },
  );
});

describe("normalizeConfigBody (write path)", () => {
  it("returns the trimmed body to store at the current version, with no defaults added", () => {
    const body = validBody();
    body.widget.greeting = "  Hi, what do you need?  ";

    const result = normalizeConfigBody(body);

    expect(result.isSuccess).toBe(true);
    expect(result.schemaVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
    expect(result.body).toEqual({
      ...validBody(),
      widget: { ...validBody().widget, greeting: "Hi, what do you need?" },
    });
    expect(result.body).not.toHaveProperty("limits");
    expect(result.body).not.toHaveProperty("attachments");
    expect(result.body?.knowledge).not.toHaveProperty("topK");
  });

  it("rejects an invalid body", () => {
    const result = normalizeConfigBody({
      ...validBody(),
      limits: { maxStepsPerTurn: 1_000_000_000_000 },
    });

    expect(result.isSuccess).toBe(false);
    expect(result.body).toBeUndefined();
    expect(result.message).toContain("limits.maxStepsPerTurn");
  });
});

describe("CONFIG_SPEC_PLATFORM_DEFAULTS", () => {
  it("sits within the current schema's bounds", () => {
    expect(ZConfigLimitsV1.safeParse(CONFIG_SPEC_PLATFORM_DEFAULTS.limits).success).toBe(true);
    expect(ZConfigAttachmentsV1.safeParse(CONFIG_SPEC_PLATFORM_DEFAULTS.attachments).success).toBe(
      true,
    );
    expect(
      ZConfigKnowledgeV1.safeParse({
        sourceIds: [],
        topK: CONFIG_SPEC_PLATFORM_DEFAULTS.knowledgeTopK,
      }).success,
    ).toBe(true);
  });
});

describe("CONFIG_SPEC_REGISTRY", () => {
  it("has an upgrader from every version below the current one, and none from the current or later", () => {
    for (let version = 1; version < CONFIG_SPEC_REGISTRY.currentVersion; version++) {
      expect(CONFIG_SPEC_REGISTRY.upgraders[version], `upgrader from v${version}`).toBeDefined();
    }
    const strayVersions = Object.keys(CONFIG_SPEC_REGISTRY.upgraders)
      .map(Number)
      .filter((version) => version < 1 || version >= CONFIG_SPEC_REGISTRY.currentVersion);
    expect(strayVersions).toEqual([]);
  });

  it("exposes its current version and schema as the current aliases", () => {
    expect(CURRENT_CONFIG_SCHEMA_VERSION).toBe(CONFIG_SPEC_REGISTRY.currentVersion);
    expect(ZConfigSpecBody).toBe(CONFIG_SPEC_REGISTRY.currentSchema);
    expect(CONFIG_SPEC_REGISTRY.currentSchema).toBe(ZConfigSpecV1);
  });
});

// DEV_NOTE: The real registry has no upgraders at v1, so the chain is driven with a three-version fixture:
// v1 { title, cap? } → v2 { name, cap? } → v3 { name, isEnabled, cap? }. cap stands in for a defaulted field.
const ZFixtureV1 = z.strictObject({ title: z.string().min(1), cap: z.number().optional() });
const ZFixtureV2 = z.strictObject({ name: z.string().min(1), cap: z.number().optional() });
const ZFixtureV3 = z.strictObject({
  name: z.string().min(1),
  isEnabled: z.boolean(),
  cap: z.number().optional(),
});

const upgradeCalls: number[] = [];
const fixtureRegistry: ConfigSpecRegistry<typeof ZFixtureV3> = {
  currentVersion: 3,
  currentSchema: ZFixtureV3,
  upgraders: {
    1: defineConfigSpecUpgrader(ZFixtureV1, ({ title, ...rest }) => {
      upgradeCalls.push(1);
      return { ...rest, name: title };
    }),
    2: defineConfigSpecUpgrader(ZFixtureV2, (body) => {
      upgradeCalls.push(2);
      return { ...body, isEnabled: true };
    }),
  },
};

describe("upgradeConfigBody", () => {
  it("runs every upgrader in order from the stored version to the current one", () => {
    upgradeCalls.length = 0;
    const result = upgradeConfigBody(fixtureRegistry, {
      schemaVersion: 1,
      body: { title: "Bot", cap: 7 },
    });

    expect(result).toEqual({
      isSuccess: true,
      body: { name: "Bot", isEnabled: true, cap: 7 },
      wasUpgraded: true,
    });
    expect(upgradeCalls).toEqual([1, 2]);
  });

  it("keeps an omitted field omitted through the chain", () => {
    const result = upgradeConfigBody(fixtureRegistry, { schemaVersion: 1, body: { title: "Bot" } });
    expect(result.body).toEqual({ name: "Bot", isEnabled: true });
  });

  it("starts the chain at the stored version", () => {
    upgradeCalls.length = 0;
    const result = upgradeConfigBody(fixtureRegistry, { schemaVersion: 2, body: { name: "Bot" } });

    expect(result.body).toEqual({ name: "Bot", isEnabled: true });
    expect(upgradeCalls).toEqual([2]);
  });

  it("parses a current-version body without upgrading it", () => {
    const body = { name: "Bot", isEnabled: false };
    expect(upgradeConfigBody(fixtureRegistry, { schemaVersion: 3, body })).toEqual({
      isSuccess: true,
      body,
      wasUpgraded: false,
    });
  });

  it("validates an old body against its own version before upgrading it", () => {
    upgradeCalls.length = 0;
    const result = upgradeConfigBody(fixtureRegistry, { schemaVersion: 1, body: { name: "Bot" } });

    expect(result.isSuccess).toBe(false);
    expect(result.message).toContain("schema version 1");
    expect(upgradeCalls).toEqual([]);
  });

  it("validates the upgraded body against the current schema", () => {
    const broken: ConfigSpecRegistry<typeof ZFixtureV3> = {
      ...fixtureRegistry,
      upgraders: {
        ...fixtureRegistry.upgraders,
        2: defineConfigSpecUpgrader(ZFixtureV2, (body) => body),
      },
    };
    const result = upgradeConfigBody(broken, { schemaVersion: 2, body: { name: "Bot" } });

    expect(result.isSuccess).toBe(false);
    expect(result.message).toContain("Invalid config body at schema version 3");
  });

  it("fails when an upgrader is missing from the chain", () => {
    const gapped: ConfigSpecRegistry<typeof ZFixtureV3> = {
      ...fixtureRegistry,
      upgraders: { 2: fixtureRegistry.upgraders[2] },
    };
    const result = upgradeConfigBody(gapped, { schemaVersion: 1, body: { title: "Bot" } });

    expect(result.isSuccess).toBe(false);
    expect(result.message).toBe("No upgrader registered from config schema version 1");
  });

  it("reports an upgrader that throws instead of throwing", () => {
    const throwing: ConfigSpecRegistry<typeof ZFixtureV2> = {
      currentVersion: 2,
      currentSchema: ZFixtureV2,
      upgraders: {
        1: defineConfigSpecUpgrader(ZFixtureV1, () => {
          throw new Error("boom");
        }),
      },
    };
    const result = upgradeConfigBody(throwing, { schemaVersion: 1, body: { title: "Bot" } });

    expect(result.isSuccess).toBe(false);
    expect(result.message).toBe("Config upgrade from schema version 1 failed: boom");
  });
});

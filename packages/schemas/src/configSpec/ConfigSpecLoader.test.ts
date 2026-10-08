import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ModelProviderEnum } from "../companySecrets";
import { CONFIG_SPEC_V1_DEFAULTS, ModelTierEnum, type ConfigSpecV1Input } from "./ConfigSpecV1";
import {
  CONFIG_SPEC_REGISTRY,
  CURRENT_CONFIG_SCHEMA_VERSION,
  defineConfigSpecUpgrader,
  type ConfigSpecRegistry,
} from "./ConfigSpecRegistry";
import { loadConfigSpec, upgradeConfigBody } from "./ConfigSpecLoader";

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

describe("loadConfigSpec", () => {
  it("loads a valid current-version body with platform defaults filled in", () => {
    const result = loadConfigSpec({
      schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      body: validBody(),
    });

    expect(result.isSuccess).toBe(true);
    expect(result.wasUpgraded).toBe(false);
    expect(result.spec?.limits).toEqual(CONFIG_SPEC_V1_DEFAULTS.limits);
    expect(result.spec?.tools).toEqual([{ name: "get_record", version: 1 }]);
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

  it("matches CURRENT_CONFIG_SCHEMA_VERSION", () => {
    expect(CONFIG_SPEC_REGISTRY.currentVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION);
  });
});

// DEV_NOTE: The real registry has no upgraders at v1, so the chain is driven with a three-version fixture:
// v1 { title } → v2 { name } → v3 { name, isEnabled }.
const ZFixtureV1 = z.strictObject({ title: z.string().min(1) });
const ZFixtureV2 = z.strictObject({ name: z.string().min(1) });

const upgradeCalls: number[] = [];
const fixtureRegistry: ConfigSpecRegistry = {
  currentVersion: 3,
  upgraders: {
    1: defineConfigSpecUpgrader(ZFixtureV1, (body) => {
      upgradeCalls.push(1);
      return { name: body.title };
    }),
    2: defineConfigSpecUpgrader(ZFixtureV2, (body) => {
      upgradeCalls.push(2);
      return { name: body.name, isEnabled: true };
    }),
  },
};

describe("upgradeConfigBody", () => {
  it("runs every upgrader in order from the stored version to the current one", () => {
    upgradeCalls.length = 0;
    const result = upgradeConfigBody(fixtureRegistry, { schemaVersion: 1, body: { title: "Bot" } });

    expect(result).toEqual({
      isSuccess: true,
      body: { name: "Bot", isEnabled: true },
      wasUpgraded: true,
    });
    expect(upgradeCalls).toEqual([1, 2]);
  });

  it("starts the chain at the stored version", () => {
    upgradeCalls.length = 0;
    const result = upgradeConfigBody(fixtureRegistry, { schemaVersion: 2, body: { name: "Bot" } });

    expect(result.body).toEqual({ name: "Bot", isEnabled: true });
    expect(upgradeCalls).toEqual([2]);
  });

  it("returns a current-version body unchanged", () => {
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

  it("fails when an upgrader is missing from the chain", () => {
    const gapped: ConfigSpecRegistry = {
      currentVersion: 3,
      upgraders: { 2: fixtureRegistry.upgraders[2] },
    };
    const result = upgradeConfigBody(gapped, { schemaVersion: 1, body: { title: "Bot" } });

    expect(result.isSuccess).toBe(false);
    expect(result.message).toBe("No upgrader registered from config schema version 1");
  });

  it("reports an upgrader that throws instead of throwing", () => {
    const throwing: ConfigSpecRegistry = {
      currentVersion: 2,
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

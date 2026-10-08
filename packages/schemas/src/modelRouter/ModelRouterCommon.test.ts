import { describe, it, expect } from "vitest";
import { ModelProviderEnum } from "../companySecrets";
import { ModelTierEnum } from "../configSpec";
import {
  MODEL_PRICES,
  MODEL_TIER_CALL_TIER_MAP,
  computeModelCallCostUsd,
  getModelPrice,
  type ModelPrice,
} from "./ModelRouterCommon";

const price: ModelPrice = {
  inputUsdPerMTok: 2,
  outputUsdPerMTok: 10,
  cacheReadUsdPerMTok: 0.1,
  cacheWriteUsdPerMTok: 2.5,
};

const longContextPrice: ModelPrice = {
  ...price,
  longContext: {
    overInputTokens: 200_000,
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 18,
    cacheReadUsdPerMTok: 0.4,
    cacheWriteUsdPerMTok: 4,
  },
};

describe("computeModelCallCostUsd", () => {
  it("prices uncached input, cache reads, cache writes and output separately", () => {
    // 1M uncached × $2 + 1M read × $0.1 + 1M write × $2.5 + 1M out × $10 = $14.6
    const cost = computeModelCallCostUsd(price, {
      inputTokens: 3_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe("14.600000");
  });

  it("rounds to the 6 decimals model_calls.cost_usd stores", () => {
    const cost = computeModelCallCostUsd(price, {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
    });
    expect(cost).toBe("0.000012");
  });

  it("applies the long-context prices to the whole call once the prompt is over the line", () => {
    const atLine = computeModelCallCostUsd(longContextPrice, {
      inputTokens: 200_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    const overLine = computeModelCallCostUsd(longContextPrice, {
      inputTokens: 200_001,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(atLine).toBe("0.400000");
    expect(overLine).toBe("0.800004");
  });

  it("never prices below zero for bad counts or more cached than total tokens", () => {
    const cost = computeModelCallCostUsd(price, {
      inputTokens: 100,
      cacheReadTokens: 1_000,
      cacheWriteTokens: Number.NaN,
      outputTokens: -5,
    });
    // 0 uncached + 1000 reads × $0.1 / 1M
    expect(cost).toBe("0.000100");
  });
});

describe("getModelPrice", () => {
  it("finds a listed model", () => {
    expect(getModelPrice(ModelProviderEnum.Anthropic, "claude-sonnet-5-5")).toBe(
      MODEL_PRICES[ModelProviderEnum.Anthropic]["claude-sonnet-5-5"],
    );
  });

  it("returns null for an unlisted model, a model of another provider, or a prototype key", () => {
    expect(getModelPrice(ModelProviderEnum.Anthropic, "claude-unknown")).toBeNull();
    expect(getModelPrice(ModelProviderEnum.OpenAI, "claude-sonnet-5-5")).toBeNull();
    expect(getModelPrice(ModelProviderEnum.Google, "constructor")).toBeNull();
    expect(getModelPrice(ModelProviderEnum.Google, "__proto__")).toBeNull();
  });

  it("lists only sane prices", () => {
    for (const models of Object.values(MODEL_PRICES)) {
      for (const modelPrice of Object.values(models)) {
        const tiers = modelPrice.longContext ? [modelPrice, modelPrice.longContext] : [modelPrice];
        for (const tier of tiers) {
          expect(tier.inputUsdPerMTok).toBeGreaterThan(0);
          expect(tier.outputUsdPerMTok).toBeGreaterThan(0);
          expect(tier.cacheReadUsdPerMTok).toBeGreaterThan(0);
          expect(tier.cacheReadUsdPerMTok).toBeLessThanOrEqual(tier.inputUsdPerMTok);
          expect(tier.cacheWriteUsdPerMTok).toBeGreaterThanOrEqual(tier.inputUsdPerMTok);
        }
      }
    }
  });
});

describe("MODEL_TIER_CALL_TIER_MAP", () => {
  it("maps every config tier", () => {
    for (const tier of Object.values(ModelTierEnum)) {
      expect(MODEL_TIER_CALL_TIER_MAP[tier]).toBeDefined();
    }
  });
});

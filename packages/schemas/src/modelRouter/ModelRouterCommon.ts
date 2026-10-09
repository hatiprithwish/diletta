import z from "zod";
import { ModelProviderEnum } from "../companySecrets";
import { ModelTierEnum } from "../configSpec";
import {
  ModelCallTierIntEnum,
  PlatformModelProviderEnum,
  type ModelCallProvider,
} from "../modelCalls";

// DEV_NOTE: Why the router handed out no model. The caller (Conversation DO) shows every one of them to the widget
// as MODEL_UNAVAILABLE_MESSAGE; the reason is logged, never shown.
//   ModelNotPriced: the config's model is missing from MODEL_PRICES, so its cost can't be counted.
//   KeyUnavailable: no active model key for the provider, or the provider rejected it. Opens a system issue.
//   ProviderError: a call failed at the provider or the gateway for any other reason (rate limit, overload, prompt
//     too long, connection lost). Its text never reaches the widget.
//   ServerError: the database, decryption or gateway config failed.
//   BudgetExceeded: BudgetDO or the caller's caps refused the call before it reached the provider (M2-4); the
//     refusal (BudgetRefusalEnum) is logged.
export enum ModelRouterFailureEnum {
  ModelNotPriced = "ModelNotPriced",
  KeyUnavailable = "KeyUnavailable",
  ProviderError = "ProviderError",
  ServerError = "ServerError",
  BudgetExceeded = "BudgetExceeded",
}

// DEV_NOTE: DESIGN.md §8 copy for the widget-Unavailable state (model key / provider failure)
export const MODEL_UNAVAILABLE_MESSAGE = "Temporarily unavailable";

// DEV_NOTE: Why a model key was judged unusable, recorded in the activity_log detail of the system issue
export enum ModelKeyFailureReasonEnum {
  NoActiveKey = "no_active_key",
  RejectedByProvider = "rejected_by_provider",
}

// DEV_NOTE: Provider names as an admin reads them (system issue notes, Settings › Model keys)
export const MODEL_PROVIDER_LABEL_MAP: Record<ModelProviderEnum, string> = {
  [ModelProviderEnum.Anthropic]: "Anthropic",
  [ModelProviderEnum.OpenAI]: "OpenAI",
  [ModelProviderEnum.Google]: "Google",
};

// Config spec tier → model_calls.tier
export const MODEL_TIER_CALL_TIER_MAP: Record<ModelTierEnum, ModelCallTierIntEnum> = {
  [ModelTierEnum.Small]: ModelCallTierIntEnum.Small,
  [ModelTierEnum.Mid]: ModelCallTierIntEnum.Mid,
  [ModelTierEnum.Top]: ModelCallTierIntEnum.Top,
};

// USD per million tokens. cacheWrite is what a token written to the provider's prompt cache costs (Anthropic
// charges a premium; OpenAI and Google charge plain input, so it equals input there).
export interface ModelTokenPrices {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
}

// DEV_NOTE: longContext replaces every price for a call whose prompt is over overInputTokens (all of the call's
// tokens, not only the ones past the line), as the providers bill it.
export interface ModelPrice extends ModelTokenPrices {
  longContext?: ModelTokenPrices & { overInputTokens: number };
}

// DEV_NOTE: Platform price table, the source of model_calls.cost_usd and the budget (AI Gateway returns no cost per
// call). Prices are the providers' list prices as of 2026-10-08 (platform.claude.com, developers.openai.com,
// ai.google.dev pricing pages). The router refuses a model that isn't listed, so a missing price can never undercount
// spend. Where a provider runs a temporary discount (Gemini 3.7 / 3.8 Flash until 2026-12-31) the regular price is
// used: the budget may overcount during the promotion, never undercount after it. A price change is a code change
// here, with its source date.
export const MODEL_PRICES: Record<ModelProviderEnum, Record<string, ModelPrice>> = {
  [ModelProviderEnum.Anthropic]: {
    "claude-fable-5-1": {
      inputUsdPerMTok: 10,
      outputUsdPerMTok: 50,
      cacheReadUsdPerMTok: 0.25,
      cacheWriteUsdPerMTok: 12.5,
    },
    "claude-opus-5-5": {
      inputUsdPerMTok: 4,
      outputUsdPerMTok: 20,
      cacheReadUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 5,
    },
    "claude-sonnet-5-5": {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 2.5,
    },
    "claude-haiku-4-5": {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
    },
    "claude-haiku-4-5-20251001": {
      inputUsdPerMTok: 1,
      outputUsdPerMTok: 5,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
    },
  },
  [ModelProviderEnum.OpenAI]: {
    "gpt-6-astra": {
      inputUsdPerMTok: 10,
      outputUsdPerMTok: 50,
      cacheReadUsdPerMTok: 1,
      cacheWriteUsdPerMTok: 10,
      longContext: {
        overInputTokens: 272_000,
        inputUsdPerMTok: 20,
        outputUsdPerMTok: 75,
        cacheReadUsdPerMTok: 2,
        cacheWriteUsdPerMTok: 20,
      },
    },
    "gpt-6.1-sol": {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 2,
      longContext: {
        overInputTokens: 272_000,
        inputUsdPerMTok: 4,
        outputUsdPerMTok: 15,
        cacheReadUsdPerMTok: 0.2,
        cacheWriteUsdPerMTok: 4,
      },
    },
    "gpt-6-sol": {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      cacheReadUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 2,
      longContext: {
        overInputTokens: 272_000,
        inputUsdPerMTok: 4,
        outputUsdPerMTok: 15,
        cacheReadUsdPerMTok: 0.4,
        cacheWriteUsdPerMTok: 4,
      },
    },
    "gpt-6-luna": {
      inputUsdPerMTok: 0.1,
      outputUsdPerMTok: 0.5,
      cacheReadUsdPerMTok: 0.01,
      cacheWriteUsdPerMTok: 0.1,
      longContext: {
        overInputTokens: 272_000,
        inputUsdPerMTok: 0.2,
        outputUsdPerMTok: 0.75,
        cacheReadUsdPerMTok: 0.02,
        cacheWriteUsdPerMTok: 0.2,
      },
    },
  },
  [ModelProviderEnum.Google]: {
    "gemini-3.8-flash": {
      inputUsdPerMTok: 1.5,
      outputUsdPerMTok: 7.5,
      cacheReadUsdPerMTok: 0.15,
      cacheWriteUsdPerMTok: 1.5,
    },
    "gemini-3.7-flash": {
      inputUsdPerMTok: 1.5,
      outputUsdPerMTok: 7.5,
      cacheReadUsdPerMTok: 0.15,
      cacheWriteUsdPerMTok: 1.5,
    },
    "gemini-3.5-flash": {
      inputUsdPerMTok: 1.5,
      outputUsdPerMTok: 9,
      cacheReadUsdPerMTok: 0.15,
      cacheWriteUsdPerMTok: 1.5,
    },
    "gemini-3.1-pro-preview": {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 12,
      cacheReadUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 2,
      longContext: {
        overInputTokens: 200_000,
        inputUsdPerMTok: 4,
        outputUsdPerMTok: 18,
        cacheReadUsdPerMTok: 0.4,
        cacheWriteUsdPerMTok: 4,
      },
    },
  },
};

// DEV_NOTE: Own-property lookup, so a model name like "constructor" or "__proto__" from a config body is never
// mistaken for a listed model
export function getModelPrice(provider: ModelProviderEnum, model: string): ModelPrice | null {
  const prices = MODEL_PRICES[provider];
  return Object.hasOwn(prices, model) ? (prices[model] ?? null) : null;
}

// DEV_NOTE: Platform-paid models (embeddings), priced like MODEL_PRICES so cost goes through computeModelCallCostUsd.
// Input-only: output and cache prices are 0 (an embedding has no output; cacheWrite equals input, so the backfill's
// dearer-of rule reads input). Workers AI list prices as of 2026-10-09
// (developers.cloudflare.com/workers-ai/platform/pricing). They never reach a company's budget (tier Embed is left out
// of BudgetRepo's seed), but every call still gets its model_calls row.
export const PLATFORM_MODEL_PRICES: Record<
  PlatformModelProviderEnum,
  Record<string, ModelPrice>
> = {
  [PlatformModelProviderEnum.WorkersAi]: {
    "@cf/baai/bge-m3": {
      inputUsdPerMTok: 0.012,
      outputUsdPerMTok: 0,
      cacheReadUsdPerMTok: 0,
      cacheWriteUsdPerMTok: 0.012,
    },
  },
};

// DEV_NOTE: The price of any model_calls row (routed or platform). Own-property lookup, as getModelPrice.
export function getModelCallPrice(provider: ModelCallProvider, model: string): ModelPrice | null {
  if (provider === PlatformModelProviderEnum.WorkersAi) {
    const prices = PLATFORM_MODEL_PRICES[provider];
    return Object.hasOwn(prices, model) ? (prices[model] ?? null) : null;
  }
  return getModelPrice(provider, model);
}

// Token counts of one call. inputTokens is the whole prompt, cache reads and writes included.
export interface ModelCallUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

// DEV_NOTE: The usage of a call the provider refused: nothing billed, so every count is a real 0
export const ZERO_MODEL_CALL_USAGE: ModelCallUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

const TOKENS_PER_MILLION = 1_000_000;
// DEV_NOTE: model_calls.cost_usd is numeric(12, 6)
const COST_DECIMALS = 6;

// DEV_NOTE: Cost of one call in USD, as the decimal string model_calls.cost_usd stores. The prompt splits into
// uncached input, cache reads and cache writes, each at its own price. Negative or non-finite counts are treated
// as 0, and the uncached part never goes below 0 even if a provider reports more cached tokens than its total.
// isRoundedUp rounds up to the column's last decimal instead of to the nearest: a cheap call (a small Workers AI
// embedding costs under $0.0000005) is then stored at $0.000001, never as $0.
export function computeModelCallCostUsd(
  price: ModelPrice,
  usage: ModelCallUsage,
  isRoundedUp = false,
): string {
  const count = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
  const inputTokens = count(usage.inputTokens);
  const cacheReadTokens = count(usage.cacheReadTokens);
  const cacheWriteTokens = count(usage.cacheWriteTokens);
  const outputTokens = count(usage.outputTokens);
  const uncachedTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);

  const prices: ModelTokenPrices =
    price.longContext && inputTokens > price.longContext.overInputTokens
      ? price.longContext
      : price;

  const cost =
    (uncachedTokens * prices.inputUsdPerMTok +
      cacheReadTokens * prices.cacheReadUsdPerMTok +
      cacheWriteTokens * prices.cacheWriteUsdPerMTok +
      outputTokens * prices.outputUsdPerMTok) /
    TOKENS_PER_MILLION;

  if (isRoundedUp) {
    const scale = 10 ** COST_DECIMALS;
    return (Math.ceil(cost * scale - 1e-9) / scale).toFixed(COST_DECIMALS);
  }
  return cost.toFixed(COST_DECIMALS);
}

// DEV_NOTE: The parts of an AI Gateway log (Cloudflare API: GET …/ai-gateway/gateways/{gateway}/logs/{id}) the usage
// backfill reads. Loose: the log carries many more fields, never read. tokens_in has no cache split.
export const ZAiGatewayLogResponse = z.looseObject({
  success: z.boolean(),
  result: z
    .looseObject({
      tokens_in: z.number().int().min(0).nullable().optional(),
      tokens_out: z.number().int().min(0).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type AiGatewayLogResponse = z.infer<typeof ZAiGatewayLogResponse>;

// DEV_NOTE: The activity_log detail of a system issue's opened / provider_added events: which provider's key failed.
// Read back to know which providers the open issue already covers (never by searching the note's free text).
export const ZModelKeyFailureDetail = z.object({
  provider: z.enum(ModelProviderEnum),
  reason: z.enum(ModelKeyFailureReasonEnum),
});
export type ModelKeyFailureDetail = z.infer<typeof ZModelKeyFailureDetail>;

import { describe, it, expect } from "vitest";
import { ModelProviderEnum } from "../companySecrets";
import { ModelTierEnum, ZConfigSpecV1 } from "../configSpec";
import { EvalRunStatusIntEnum } from "../evalRuns/EvalRunsCommon";
import { ChatbotConfigTestResultEnum, chatbotConfigTestResult } from "./ChatbotConfigsCommon";
import { getChatbotConfigPublishNeeds } from "./ChatbotConfigsPublish";

function body(routing: { small: string[]; mid: string[]; top: string[] }) {
  const tier = ([provider, model]: string[]) => ({
    provider: provider as ModelProviderEnum,
    model: model!,
  });
  return ZConfigSpecV1.parse({
    persona: { instructions: "Help." },
    procedures: [],
    tools: [
      { name: "get_record", version: 1 },
      { name: "update_record", version: 3 },
    ],
    approvalRules: [],
    routing: {
      small: tier(routing.small),
      mid: tier(routing.mid),
      top: tier(routing.top),
      defaultTier: ModelTierEnum.Mid,
    },
    knowledge: { sourceIds: [] },
    widget: { greeting: "Hi", suggestions: [] },
  });
}

describe("getChatbotConfigPublishNeeds", () => {
  it("names each routing provider once, in tier order, and every pin", () => {
    const needs = getChatbotConfigPublishNeeds(
      body({
        small: [ModelProviderEnum.Google, "gemini-3.5-flash"],
        mid: [ModelProviderEnum.Google, "gemini-3.8-flash"],
        top: [ModelProviderEnum.Anthropic, "claude-sonnet-5-5"],
      }),
    );
    expect(needs.providers).toEqual([ModelProviderEnum.Google, ModelProviderEnum.Anthropic]);
    expect(needs.unpricedModels).toEqual([]);
    expect(needs.pins).toEqual([
      { name: "get_record", version: 1 },
      { name: "update_record", version: 3 },
    ]);
  });

  it("lists the models the router can't price, once each", () => {
    const needs = getChatbotConfigPublishNeeds(
      body({
        small: [ModelProviderEnum.OpenAI, "gpt-unknown"],
        mid: [ModelProviderEnum.OpenAI, "gpt-unknown"],
        top: [ModelProviderEnum.Anthropic, "claude-sonnet-5-5"],
      }),
    );
    expect(needs.unpricedModels).toEqual(["openai/gpt-unknown"]);
  });
});

describe("chatbotConfigTestResult", () => {
  it("reads a version's newest run", () => {
    expect(chatbotConfigTestResult(null)).toBe(ChatbotConfigTestResultEnum.NotRun);
    expect(chatbotConfigTestResult({ status: EvalRunStatusIntEnum.Queued, hasPassed: null })).toBe(
      ChatbotConfigTestResultEnum.Running,
    );
    expect(chatbotConfigTestResult({ status: EvalRunStatusIntEnum.Running, hasPassed: null })).toBe(
      ChatbotConfigTestResultEnum.Running,
    );
    expect(chatbotConfigTestResult({ status: EvalRunStatusIntEnum.Done, hasPassed: true })).toBe(
      ChatbotConfigTestResultEnum.Passed,
    );
    expect(chatbotConfigTestResult({ status: EvalRunStatusIntEnum.Done, hasPassed: false })).toBe(
      ChatbotConfigTestResultEnum.Failed,
    );
    expect(chatbotConfigTestResult({ status: EvalRunStatusIntEnum.Failed, hasPassed: null })).toBe(
      ChatbotConfigTestResultEnum.Failed,
    );
  });
});

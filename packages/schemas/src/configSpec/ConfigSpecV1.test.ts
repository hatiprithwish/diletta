import { describe, it, expect } from "vitest";
import { ModelProviderEnum } from "../companySecrets";
import {
  ApprovalRuleApprovalEnum,
  ModelTierEnum,
  ZConfigSpecV1,
  type ConfigSpecV1Input,
} from "./ConfigSpecV1";

// Minimal valid body: every required section, nothing that has a platform default
function minimalBody(): ConfigSpecV1Input {
  return {
    persona: { instructions: "You help facility managers with their registers." },
    procedures: [],
    tools: [],
    approvalRules: [],
    routing: {
      small: { provider: ModelProviderEnum.Google, model: "gemini-flash-lite" },
      mid: { provider: ModelProviderEnum.Google, model: "gemini-flash" },
      top: { provider: ModelProviderEnum.Anthropic, model: "claude-sonnet" },
      defaultTier: ModelTierEnum.Mid,
    },
    knowledge: { sourceIds: [] },
    widget: { greeting: "Hi, what do you need?", suggestions: [] },
  };
}

function fullBody(): ConfigSpecV1Input {
  return {
    ...minimalBody(),
    procedures: [
      {
        name: "Close inspection",
        whenToUse: "The user asks to close an inspection",
        steps: "Read the record, show the change, wait for approval.",
      },
    ],
    tools: [
      { name: "get_record", version: 1 },
      { name: "update_record", version: 3 },
    ],
    approvalRules: [
      { roles: ["admin"], tools: ["update_record"], approval: ApprovalRuleApprovalEnum.Auto },
      { roles: [], tools: [], approval: ApprovalRuleApprovalEnum.Required },
    ],
    knowledge: { sourceIds: ["ks_a1", "ks_b2"], topK: 8 },
    widget: {
      greeting: "Hi Priya, what do you need?",
      suggestions: ["Which inspections are overdue?"],
      launcherLabel: "Ask about your registers",
    },
    limits: { maxStepsPerTurn: 20, turnCostCapUsd: 1.25 },
    attachments: { isImageUploadEnabled: true },
  };
}

function issuePaths(body: unknown): string[] {
  const result = ZConfigSpecV1.safeParse(body);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("ZConfigSpecV1 valid bodies", () => {
  // DEV_NOTE: The versioned schema is the stored shape. Parsing must never add a field the body omitted, or a
  // stored / upgraded body would freeze today's platform defaults as company values (ConfigSpecDefaults.ts).
  it("parses a minimal body without adding any omitted field", () => {
    const result = ZConfigSpecV1.safeParse(minimalBody());

    expect(result.success).toBe(true);
    expect(result.data).toEqual(minimalBody());
  });

  it("keeps a full body as given, company overrides included", () => {
    const result = ZConfigSpecV1.safeParse(fullBody());

    expect(result.success).toBe(true);
    expect(result.data).toEqual(fullBody());
  });

  it("trims text", () => {
    const body = minimalBody();
    body.widget.greeting = "  Hi there  ";
    body.persona.instructions = "\n Help with registers. \n";

    const result = ZConfigSpecV1.safeParse(body);
    expect(result.data?.widget.greeting).toBe("Hi there");
    expect(result.data?.persona.instructions).toBe("Help with registers.");
  });
});

describe("ZConfigSpecV1 invalid bodies are rejected", () => {
  it("rejects a body that is not an object", () => {
    expect(ZConfigSpecV1.safeParse(null).success).toBe(false);
    expect(ZConfigSpecV1.safeParse("persona").success).toBe(false);
  });

  it("rejects a missing required section", () => {
    const { routing: _routing, ...body } = minimalBody();
    expect(issuePaths(body)).toContain("routing");
  });

  it("rejects an unknown key, at the top level and inside a section", () => {
    expect(issuePaths({ ...minimalBody(), persona_v2: {} })).toContain("");
    expect(
      issuePaths({ ...minimalBody(), widget: { greeting: "Hi", suggestions: [], theme: "dark" } }),
    ).toContain("widget");
  });

  it("rejects a wrong type", () => {
    expect(
      issuePaths({ ...minimalBody(), tools: [{ name: "get_record", version: "1" }] }),
    ).toContain("tools.0.version");
  });

  it("rejects blank text after trimming", () => {
    expect(issuePaths({ ...minimalBody(), persona: { instructions: "   " } })).toContain(
      "persona.instructions",
    );
  });

  it("rejects more than three widget suggestions", () => {
    const body = minimalBody();
    body.widget.suggestions = ["a", "b", "c", "d"];
    expect(issuePaths(body)).toContain("widget.suggestions");
  });

  it("rejects an unsupported model provider or tier", () => {
    const body = minimalBody();
    expect(
      issuePaths({
        ...body,
        routing: { ...body.routing, top: { provider: "mistral", model: "x" } },
      }),
    ).toContain("routing.top.provider");
    expect(issuePaths({ ...body, routing: { ...body.routing, defaultTier: "huge" } })).toContain(
      "routing.defaultTier",
    );
  });

  it("rejects zero, negative and fractional limits", () => {
    expect(issuePaths({ ...minimalBody(), limits: { maxStepsPerTurn: 0 } })).toContain(
      "limits.maxStepsPerTurn",
    );
    expect(issuePaths({ ...minimalBody(), limits: { turnCostCapUsd: -1 } })).toContain(
      "limits.turnCostCapUsd",
    );
    expect(issuePaths({ ...minimalBody(), limits: { maxTokensPerTurn: 1.5 } })).toContain(
      "limits.maxTokensPerTurn",
    );
  });

  it("rejects an unknown approval value", () => {
    expect(
      issuePaths({
        ...minimalBody(),
        approvalRules: [{ roles: [], tools: [], approval: "maybe" }],
      }),
    ).toContain("approvalRules.0.approval");
  });

  it("rejects duplicate tool, procedure and knowledge source entries", () => {
    const body = fullBody();
    const paths = issuePaths({
      ...body,
      tools: [...(body.tools ?? []), { name: "get_record", version: 2 }],
      procedures: [...(body.procedures ?? []), ...(body.procedures ?? [])],
      knowledge: { sourceIds: ["ks_a1", "ks_a1"] },
    });

    expect(paths).toContain("tools.2");
    expect(paths).toContain("procedures.1");
    expect(paths).toContain("knowledge.sourceIds.1");
  });

  it("rejects an approval rule that names a tool not pinned in tools", () => {
    const body = fullBody();
    expect(
      issuePaths({
        ...body,
        approvalRules: [
          { roles: [], tools: ["delete_record"], approval: ApprovalRuleApprovalEnum.Blocked },
        ],
      }),
    ).toContain("approvalRules.0.tools.0");
  });

  it.each([
    ["maxStepsPerTurn", 51],
    ["maxTokensPerTurn", 1_000_001],
    ["turnTimeoutSeconds", 901],
    ["turnCostCapUsd", 100.01],
    ["conversationTurnsPerHour", 601],
    ["conversationCostCapUsd", 1_000.01],
    ["userMessagesPerMinute", 61],
    ["userDailyCostCapUsd", 1_000.01],
  ])("rejects limits.%s above its maximum (%s)", (field, value) => {
    expect(issuePaths({ ...minimalBody(), limits: { [field]: value } })).toContain(
      `limits.${field}`,
    );
  });

  it("rejects attachments and topK above their maximum", () => {
    expect(issuePaths({ ...minimalBody(), attachments: { maxImagesPerMessage: 11 } })).toContain(
      "attachments.maxImagesPerMessage",
    );
    expect(
      issuePaths({ ...minimalBody(), attachments: { maxImageBytes: 20 * 1024 * 1024 + 1 } }),
    ).toContain("attachments.maxImageBytes");
    expect(issuePaths({ ...minimalBody(), knowledge: { sourceIds: [], topK: 21 } })).toContain(
      "knowledge.topK",
    );
  });
});

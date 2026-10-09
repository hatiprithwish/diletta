import * as Schemas from "@app/schemas";

// DEV_NOTE: One turn's local caps (M2-4), checked in the Conversation DO's memory before every model call, on top of
// BudgetDO's company budget: maxTokensPerTurn and turnCostCapUsd for the turn, conversationCostCapUsd for the
// conversation. What counts is used + held, as in BudgetDO. Pure apart from onSpent, through which the caller keeps the
// conversation's settled spend in its own storage (getConversationSpentMicros reads it back), so the cap holds across
// turns, wakes and evictions. The Conversation DO also stops the turn's loop once isExhausted (stopWhen), so a turn at
// its cap ends instead of failing its next step.
export default class TurnBudgetProvider implements Schemas.ModelCallCaps {
  readonly userDailyCostCapUsd: number;
  private readonly maxTokens: number;
  private readonly turnCapMicros: number;
  private readonly conversationCapMicros: number;
  private readonly getConversationSpentMicros: () => number;
  private readonly onSpent: (costMicros: number) => void;
  private spentMicros = 0;
  private heldMicros = 0;
  private usedTokens = 0;
  private heldTokens = 0;

  constructor(params: {
    limits: Schemas.ConfigSpec["limits"];
    getConversationSpentMicros: () => number;
    onSpent: (costMicros: number) => void;
  }) {
    this.userDailyCostCapUsd = params.limits.userDailyCostCapUsd;
    this.maxTokens = params.limits.maxTokensPerTurn;
    this.turnCapMicros = Schemas.usdToMicros(params.limits.turnCostCapUsd);
    this.conversationCapMicros = Schemas.usdToMicros(params.limits.conversationCostCapUsd);
    this.getConversationSpentMicros = params.getConversationSpentMicros;
    this.onSpent = params.onSpent;
  }

  // DEV_NOTE: What the next call may generate: the turn's tokens left after its prompt (0 = none)
  maxOutputTokens(estimatedInputTokens: number): number {
    return Math.max(0, this.maxTokens - this.usedTokens - this.heldTokens - estimatedInputTokens);
  }

  reserve(params: { amountMicros: number; tokens: number }): Schemas.BudgetRefusalEnum | null {
    if (this.usedTokens + this.heldTokens + params.tokens > this.maxTokens) {
      return Schemas.BudgetRefusalEnum.TurnTokens;
    }
    if (this.spentMicros + this.heldMicros + params.amountMicros > this.turnCapMicros) {
      return Schemas.BudgetRefusalEnum.TurnCost;
    }
    const conversationUsed = this.getConversationSpentMicros() + this.heldMicros;
    if (conversationUsed + params.amountMicros > this.conversationCapMicros) {
      return Schemas.BudgetRefusalEnum.ConversationCost;
    }
    this.heldMicros += params.amountMicros;
    this.heldTokens += params.tokens;
    return null;
  }

  settle(params: {
    amountMicros: number;
    tokens: number;
    costMicros: number;
    usedTokens: number;
  }): void {
    this.heldMicros = Math.max(0, this.heldMicros - params.amountMicros);
    this.heldTokens = Math.max(0, this.heldTokens - params.tokens);
    this.spentMicros += params.costMicros;
    this.usedTokens += params.usedTokens;
    if (params.costMicros > 0) this.onSpent(params.costMicros);
  }

  // DEV_NOTE: No room for another call: the turn's tokens or cost, or the conversation's cost, is used up
  isExhausted(): boolean {
    return (
      this.usedTokens >= this.maxTokens ||
      this.spentMicros >= this.turnCapMicros ||
      this.getConversationSpentMicros() >= this.conversationCapMicros
    );
  }
}

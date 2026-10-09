import * as Schemas from "@app/schemas";

// DEV_NOTE: One turn's local caps (M2-4), created per turn by the Conversation DO and checked before every model call
// of that turn, on top of BudgetDO's company budget. Stateful (unlike the static providers/), so it lives in budget/:
//   - maxTokensPerTurn: the turn's OUTPUT tokens. The prompt is bounded by Think's context handling and paid for
//     through the cost caps; counting it here would starve long conversations.
//   - turnCostCapUsd and conversationCostCapUsd: cost, as used + held, like BudgetDO.
// A call whose usage isn't known is charged its whole cost hold but no output tokens: tokens are a length control,
// cost is the money guard, and a retry after a failed attempt must still have its tokens. The conversation's settled
// spend lives in the caller's storage (getConversationSpentMicros / onSpent), so its cap holds across turns, wakes
// and evictions. isExhausted ends the turn's loop (stopWhen) once a cap is used up.
export default class TurnBudget implements Schemas.ModelCallCaps {
  readonly userDailyCostCapUsd: number;
  private readonly maxOutputTokens: number;
  private readonly turnCapMicros: number;
  private readonly conversationCapMicros: number;
  private readonly getConversationSpentMicros: () => number;
  private readonly onSpent: (costMicros: number) => void;
  private spentMicros = 0;
  private heldMicros = 0;
  private usedOutputTokens = 0;
  private heldOutputTokens = 0;

  constructor(params: {
    limits: Schemas.ConfigSpec["limits"];
    getConversationSpentMicros: () => number;
    onSpent: (costMicros: number) => void;
  }) {
    this.userDailyCostCapUsd = params.limits.userDailyCostCapUsd;
    this.maxOutputTokens = params.limits.maxTokensPerTurn;
    this.turnCapMicros = Schemas.usdToMicros(params.limits.turnCostCapUsd);
    this.conversationCapMicros = Schemas.usdToMicros(params.limits.conversationCostCapUsd);
    this.getConversationSpentMicros = params.getConversationSpentMicros;
    this.onSpent = params.onSpent;
  }

  remaining(): {
    outputTokens: number;
    costMicros: number;
    costRefusal: Schemas.BudgetRefusalEnum;
  } {
    const turnLeft = this.turnCapMicros - this.spentMicros - this.heldMicros;
    const conversationLeft =
      this.conversationCapMicros - this.getConversationSpentMicros() - this.heldMicros;
    return {
      outputTokens: Math.max(
        0,
        this.maxOutputTokens - this.usedOutputTokens - this.heldOutputTokens,
      ),
      costMicros: Math.max(0, Math.min(turnLeft, conversationLeft)),
      costRefusal:
        conversationLeft < turnLeft
          ? Schemas.BudgetRefusalEnum.ConversationCost
          : Schemas.BudgetRefusalEnum.TurnCost,
    };
  }

  reserve(hold: { amountMicros: number; outputTokens: number }): Schemas.BudgetRefusalEnum | null {
    const left = this.remaining();
    if (hold.outputTokens > left.outputTokens) {
      return Schemas.BudgetRefusalEnum.TurnTokens;
    }
    if (hold.amountMicros > left.costMicros) {
      return left.costRefusal;
    }
    this.heldMicros += hold.amountMicros;
    this.heldOutputTokens += hold.outputTokens;
    return null;
  }

  settle(params: {
    amountMicros: number;
    outputTokens: number;
    costMicros: number;
    usedOutputTokens: number;
  }): void {
    this.heldMicros = Math.max(0, this.heldMicros - params.amountMicros);
    this.heldOutputTokens = Math.max(0, this.heldOutputTokens - params.outputTokens);
    this.spentMicros += params.costMicros;
    this.usedOutputTokens += params.usedOutputTokens;
    if (params.costMicros > 0) this.onSpent(params.costMicros);
  }

  // DEV_NOTE: No room for another call: the turn's output tokens or cost, or the conversation's cost, is used up
  isExhausted(): boolean {
    return (
      this.usedOutputTokens >= this.maxOutputTokens ||
      this.spentMicros >= this.turnCapMicros ||
      this.getConversationSpentMicros() >= this.conversationCapMicros
    );
  }
}

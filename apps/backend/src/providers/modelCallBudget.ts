import Constants from "@/config/Constants";
import { BudgetDO } from "@/durable-objects/BudgetDO";
import AppLogger from "@/providers/logger";
import * as Schemas from "@app/schemas";

// DEV_NOTE: One provider call's budget (M2-4), for the router: size the call, hold it, settle it. Never throws.
//   size (pure): the call may generate the requested output (≤ MODEL_CALL_MAX_OUTPUT_TOKENS), cut to the caller's
//     output tokens left and to what its cost left can pay for at the model's output price, so a pricey model gets a
//     shorter answer instead of a refusal. Input is priced at the plain input rate (the long-context rate past its
//     line). Below MODEL_CALL_MIN_OUTPUT_TOKENS (or the request, if smaller) the call is refused: an answer that short
//     isn't worth sending.
//   reserve: the caller's caps hold first, then BudgetDO (company budget + the chatbot user's daily cap); a BudgetDO
//     refusal or an unreachable BudgetDO (fail closed) releases the caps' hold.
//   settle: the hold becomes the call's cost, or stays whole when its usage isn't known (Pending / Unknown). The caps
//     settle at once; BudgetDO in waitUntil (a failed settle expires into spend later, never lost).
export default class ModelCallBudgetProvider {
  static size(params: {
    price: Schemas.ModelPrice;
    estimate: Schemas.ModelCallEstimate;
    remaining: ReturnType<Schemas.ModelCallCaps["remaining"]> | null;
  }):
    | { isSuccess: true; amountMicros: number; maxOutputTokens: number }
    | { isSuccess: false; refusal: Schemas.BudgetRefusalEnum } {
    const { price, estimate, remaining } = params;
    const prices =
      price.longContext && estimate.inputTokens > price.longContext.overInputTokens
        ? price.longContext
        : price;
    const holdMicros = (outputTokens: number) =>
      Schemas.usdToMicros(
        Schemas.computeModelCallCostUsd(price, {
          inputTokens: estimate.inputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens,
        }),
      );

    let maxOutputTokens = estimate.requestedMaxOutputTokens;
    if (remaining) {
      // DEV_NOTE: USD per million tokens = micro-dollars per token. One micro is kept back for the hold's rounding up.
      const affordable = Math.floor(
        (remaining.costMicros - holdMicros(0) - 1) / prices.outputUsdPerMTok,
      );
      maxOutputTokens = Math.min(maxOutputTokens, remaining.outputTokens, affordable);
    }

    const minimum = Math.min(
      Constants.MODEL_CALL_MIN_OUTPUT_TOKENS,
      estimate.requestedMaxOutputTokens,
    );
    if (maxOutputTokens < minimum) {
      const isTokensLeft = !remaining || remaining.outputTokens >= minimum;
      return {
        isSuccess: false,
        refusal: isTokensLeft
          ? (remaining?.costRefusal ?? Schemas.BudgetRefusalEnum.TurnCost)
          : Schemas.BudgetRefusalEnum.TurnTokens,
      };
    }
    return { isSuccess: true, amountMicros: holdMicros(maxOutputTokens), maxOutputTokens };
  }

  static async reserve(
    env: Env,
    params: {
      request: Schemas.GetModelRequest;
      price: Schemas.ModelPrice;
      estimate: Schemas.ModelCallEstimate;
    },
  ): Promise<Schemas.ModelCallHoldResponse> {
    const { request } = params;
    const caps = request.caps;
    const metadata = {
      companyId: request.companyId,
      conversationId: request.conversationId,
      turnId: request.turnId,
      inputTokens: params.estimate.inputTokens,
    };

    const sized = ModelCallBudgetProvider.size({
      price: params.price,
      estimate: params.estimate,
      remaining: caps?.remaining() ?? null,
    });
    const localRefusal = sized.isSuccess
      ? (caps?.reserve({ amountMicros: sized.amountMicros, outputTokens: sized.maxOutputTokens }) ??
        null)
      : sized.refusal;
    if (!sized.isSuccess || localRefusal) {
      const refusal = localRefusal ?? Schemas.BudgetRefusalEnum.TurnCost;
      AppLogger.warn({
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.ReserveBudget,
        message: "Caller's cap refused the call",
        metadata: { ...metadata, refusal },
      });
      return { isSuccess: false, refusal };
    }

    const release = () =>
      caps?.settle({
        amountMicros: sized.amountMicros,
        outputTokens: sized.maxOutputTokens,
        costMicros: 0,
        usedOutputTokens: 0,
      });
    let reserved: Schemas.BudgetReservationResponse;
    try {
      reserved = await BudgetDO.forCompany(env, request.companyId).reserve({
        companyId: request.companyId,
        chatbotUserId: request.chatbotUserId,
        userDailyCostCapUsd:
          request.chatbotUserId === null ? null : (caps?.userDailyCostCapUsd ?? null),
        amountMicros: sized.amountMicros,
      });
    } catch (error) {
      AppLogger.error({
        category: Schemas.LogCategory.Budget,
        action: Schemas.LogAction.ReserveBudget,
        message: "BudgetDO unreachable; call refused",
        error,
        metadata,
      });
      reserved = { isSuccess: false, refusal: Schemas.BudgetRefusalEnum.Unavailable };
    }

    if (!reserved.isSuccess || !reserved.reservationId) {
      release();
      return {
        isSuccess: false,
        refusal: reserved.refusal ?? Schemas.BudgetRefusalEnum.Unavailable,
      };
    }
    return {
      isSuccess: true,
      hold: {
        reservationId: reserved.reservationId,
        amountMicros: sized.amountMicros,
        outputTokens: sized.maxOutputTokens,
        maxOutputTokens: sized.maxOutputTokens,
      },
    };
  }

  static settle(
    env: Env,
    ctx: Pick<ExecutionContext, "waitUntil">,
    params: {
      request: Schemas.GetModelRequest;
      price: Schemas.ModelPrice;
      record: Schemas.ModelCallRecord;
      hold: Schemas.ModelCallHold;
    },
  ): void {
    const { request, record, hold } = params;
    const costMicros = record.usage
      ? Schemas.usdToMicros(Schemas.computeModelCallCostUsd(params.price, record.usage))
      : null;
    request.caps?.settle({
      amountMicros: hold.amountMicros,
      outputTokens: hold.outputTokens,
      costMicros: costMicros ?? hold.amountMicros,
      usedOutputTokens: record.usage?.outputTokens ?? 0,
    });

    ctx.waitUntil(
      BudgetDO.forCompany(env, request.companyId)
        .settle({ companyId: request.companyId, reservationId: hold.reservationId, costMicros })
        .then((settled) => {
          if (!settled.isSuccess) throw new Error(settled.message ?? "Settle refused");
        })
        .catch((error: unknown) => {
          AppLogger.error({
            category: Schemas.LogCategory.Budget,
            action: Schemas.LogAction.SettleBudget,
            message: "Budget not settled; the hold expires into spend",
            error,
            metadata: {
              companyId: request.companyId,
              conversationId: request.conversationId,
              reservationId: hold.reservationId,
            },
          });
        }),
    );
  }
}

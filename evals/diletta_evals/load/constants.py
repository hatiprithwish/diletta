"""packages/schemas constants the load test needs, read from the generated types (evals/schemas/eval-load.schema.json,
pnpm evals:types), never copied by hand: a change on the TypeScript side changes them here, and pnpm evals:check fails
until the types are regenerated.
"""

import typing

from diletta_evals.types.eval_load import EvalLoadConstants


def _literal(field: str) -> typing.Any:
    (value,) = typing.get_args(EvalLoadConstants.model_fields[field].annotation)
    return value


TARGET_CONCURRENT_CHATS: int = _literal("targetConcurrentChats")
BUDGET_OP_P95_MAX_MS: int = _literal("budgetOpP95MaxMs")
OUTBOX_LAG_P95_MAX_MS: int = _literal("outboxLagP95MaxMs")
STUB_MODEL_KEY_PREFIX: str = _literal("stubModelKeyPrefix")
CONTENTION_MAX_AMOUNT_MICROS: int = _literal("contentionMaxAmountMicros")

WIDGET_SUBPROTOCOL: str = _literal("widgetSubprotocol")
CHAT_REQUEST_FRAME_TYPE: str = _literal("widgetChatRequestFrameType")
HOST_TOKEN_FRAME_TYPE: str = _literal("widgetHostTokenFrameType")
FEEDBACK_FRAME_TYPE: str = _literal("widgetFeedbackFrameType")
FEEDBACK_RATING_DOWN: int = _literal("feedbackRatingDown")

# The Agents SDK's own chat frame (agents MessageType CF_AGENT_USE_CHAT_RESPONSE): the answer to a chat request, one
# frame per stream chunk, the last with done true. Not in packages/schemas: it is Think's protocol, not ours.
CHAT_RESPONSE_FRAME_TYPE = "cf_agent_use_chat_response"

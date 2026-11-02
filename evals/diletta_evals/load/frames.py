"""The widget socket's frames (GET /widget/ws), as a client speaks and reads them.

Sent: Think's chat request (the Agents SDK's cf_agent_use_chat_request), the host token and a rating. Read: the DO's own
frames (packages/schemas ZWidgetServerMessage: conversation, error, unavailable, closed, feedback, ...) and Think's chat
response, one frame per stream chunk. Anything else is ignored: the DO also sends change request and token frames a
chatbot with no tools never produces.
"""

import json
from dataclasses import dataclass

from diletta_evals.load.constants import (
    CHAT_REQUEST_FRAME_TYPE,
    CHAT_RESPONSE_FRAME_TYPE,
    FEEDBACK_FRAME_TYPE,
    HOST_TOKEN_FRAME_TYPE,
)


@dataclass(frozen=True)
class ConversationFrame:
    conversation_id: str


@dataclass(frozen=True)
class ChatChunkFrame:
    request_id: str
    # The chunk's own type ("start", "text-delta", "finish", ...), "" when the frame carried none
    chunk_type: str
    # The assistant message's id, on the "start" chunk
    message_id: str | None
    is_done: bool
    # The error text of a stream that failed
    error: str | None


@dataclass(frozen=True)
class FeedbackFrame:
    message_id: str
    # None = the rating wasn't saved
    rating: int | None


@dataclass(frozen=True)
class NoticeFrame:
    """unavailable (the chatbot can't answer), error (a frame the DO refused) or closed (the conversation ended)."""

    kind: str
    message: str


@dataclass(frozen=True)
class OtherFrame:
    frame_type: str


Frame = ConversationFrame | ChatChunkFrame | FeedbackFrame | NoticeFrame | OtherFrame


def chat_request_frame(*, request_id: str, message_id: str, text: str) -> str:
    """A user turn. The DO reads only the newest message, so that is all that is sent (as the widget does)."""
    body = {
        "messages": [{"id": message_id, "role": "user", "parts": [{"type": "text", "text": text}]}],
        "trigger": "submit-message",
    }
    return json.dumps(
        {
            "id": request_id,
            "init": {"method": "POST", "body": json.dumps(body)},
            "type": CHAT_REQUEST_FRAME_TYPE,
        }
    )


def host_token_frame(token: str) -> str:
    return json.dumps({"type": HOST_TOKEN_FRAME_TYPE, "token": token})


def feedback_frame(*, message_id: str, rating: int) -> str:
    return json.dumps({"type": FEEDBACK_FRAME_TYPE, "messageId": message_id, "rating": rating})


def parse_frame(raw: str | bytes) -> Frame:
    """A frame the server sent. One that isn't JSON, or has no type, is Other."""
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return OtherFrame("")
    if not isinstance(data, dict):
        return OtherFrame("")
    frame_type = data.get("type")
    if not isinstance(frame_type, str):
        return OtherFrame("")

    if frame_type == "conversation":
        conversation = data.get("conversation")
        public_id = conversation.get("publicId") if isinstance(conversation, dict) else None
        return ConversationFrame(public_id) if isinstance(public_id, str) else OtherFrame(frame_type)
    if frame_type == CHAT_RESPONSE_FRAME_TYPE:
        return _chat_chunk(data)
    if frame_type == "feedback":
        message_id = data.get("messageId")
        rating = data.get("rating")
        if isinstance(message_id, str):
            return FeedbackFrame(message_id, rating if isinstance(rating, int) else None)
    if frame_type in ("unavailable", "error", "closed"):
        message = data.get("message")
        return NoticeFrame(frame_type, message if isinstance(message, str) else "")
    return OtherFrame(frame_type)


def _chat_chunk(data: dict[str, object]) -> Frame:
    request_id = data.get("id")
    if not isinstance(request_id, str):
        return OtherFrame(CHAT_RESPONSE_FRAME_TYPE)
    body = data.get("body")
    error = (str(body) or "Stream error") if data.get("error") else None
    chunk_type = ""
    message_id: str | None = None
    if isinstance(body, str) and body.strip() and error is None:
        try:
            chunk = json.loads(body)
        except ValueError:
            chunk = None
        if isinstance(chunk, dict):
            chunk_type = chunk["type"] if isinstance(chunk.get("type"), str) else ""
            raw_id = chunk.get("messageId")
            message_id = raw_id if isinstance(raw_id, str) else None
    return ChatChunkFrame(
        request_id=request_id,
        chunk_type=chunk_type,
        message_id=message_id,
        is_done=data.get("done") is True,
        error=error,
    )

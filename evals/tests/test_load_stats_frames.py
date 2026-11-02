"""The load test's percentile rule and the widget socket's frames (diletta_evals.load.stats, .frames)."""

import json

from diletta_evals.load import frames
from diletta_evals.load.constants import (
    CHAT_REQUEST_FRAME_TYPE,
    CHAT_RESPONSE_FRAME_TYPE,
    FEEDBACK_FRAME_TYPE,
    FEEDBACK_RATING_DOWN,
    HOST_TOKEN_FRAME_TYPE,
)
from diletta_evals.load.stats import percentile, summarize


def test_percentile_is_the_nearest_rank_like_the_backends() -> None:
    samples = [float(n) for n in range(1, 11)]
    assert percentile(samples, 0.5) == 5
    assert percentile(samples, 0.95) == 10
    assert percentile(samples, 0) == 1
    assert percentile([], 0.95) == 0


def test_summarize_orders_its_input_and_reports_zeros_for_none() -> None:
    summary = summarize([float(100 - n) for n in range(100)])
    assert (summary.count, summary.p50_ms, summary.p95_ms, summary.max_ms) == (100, 50, 95, 100)
    empty = summarize([])
    assert (empty.count, empty.p95_ms, empty.max_ms) == (0, 0, 0)


def test_one_slow_sample_sets_the_max_not_the_p95() -> None:
    summary = summarize([5.0] * 19 + [900.0])
    assert summary.p95_ms == 5
    assert summary.max_ms == 900


def test_chat_request_carries_only_the_newest_user_message_as_the_widget_sends_it() -> None:
    frame = json.loads(frames.chat_request_frame(request_id="req1", message_id="m1", text="Hello"))
    assert frame["type"] == CHAT_REQUEST_FRAME_TYPE
    assert frame["id"] == "req1"
    assert frame["init"]["method"] == "POST"
    body = json.loads(frame["init"]["body"])
    assert body == {
        "messages": [{"id": "m1", "role": "user", "parts": [{"type": "text", "text": "Hello"}]}],
        "trigger": "submit-message",
    }


def test_host_token_and_feedback_frames() -> None:
    assert json.loads(frames.host_token_frame("tok")) == {"type": HOST_TOKEN_FRAME_TYPE, "token": "tok"}
    assert json.loads(frames.feedback_frame(message_id="m1", rating=FEEDBACK_RATING_DOWN)) == {
        "type": FEEDBACK_FRAME_TYPE,
        "messageId": "m1",
        "rating": FEEDBACK_RATING_DOWN,
    }


def chunk(request_id: str, body: object, *, done: bool = False, error: bool = False) -> str:
    return json.dumps(
        {
            "type": CHAT_RESPONSE_FRAME_TYPE,
            "id": request_id,
            "body": body if isinstance(body, str) else json.dumps(body),
            "done": done,
            **({"error": True} if error else {}),
        }
    )


def test_parses_the_conversation_frame() -> None:
    raw = json.dumps({"type": "conversation", "conversation": {"publicId": "cv1"}, "chatbot": {}, "feedback": []})
    assert frames.parse_frame(raw) == frames.ConversationFrame("cv1")


def test_parses_a_chat_response_chunk_and_its_message_id() -> None:
    start = frames.parse_frame(chunk("req1", {"type": "start", "messageId": "msg_1"}))
    assert start == frames.ChatChunkFrame("req1", "start", "msg_1", False, None)
    last = frames.parse_frame(chunk("req1", "", done=True))
    assert isinstance(last, frames.ChatChunkFrame)
    assert last.is_done and last.chunk_type == "" and last.error is None


def test_a_failed_stream_carries_its_error() -> None:
    failed = frames.parse_frame(chunk("req1", "Model unavailable", error=True))
    assert isinstance(failed, frames.ChatChunkFrame)
    assert failed.error == "Model unavailable"


def test_parses_feedback_acks_and_notices() -> None:
    assert frames.parse_frame(json.dumps({"type": "feedback", "messageId": "m1", "rating": 2})) == frames.FeedbackFrame(
        "m1", 2
    )
    assert frames.parse_frame(json.dumps({"type": "feedback", "messageId": "m1", "rating": None})) == frames.FeedbackFrame(
        "m1", None
    )
    for kind in ("unavailable", "error"):
        assert frames.parse_frame(json.dumps({"type": kind, "message": "No"})) == frames.NoticeFrame(kind, "No")
    assert frames.parse_frame(json.dumps({"type": "closed"})) == frames.NoticeFrame("closed", "")


def test_everything_else_is_other() -> None:
    for raw in ["not json", "[]", "{}", json.dumps({"type": "change_request"}), json.dumps({"type": 1})]:
        assert isinstance(frames.parse_frame(raw), frames.OtherFrame)
    assert frames.parse_frame(json.dumps({"type": "token_needed", "reason": "refresh"})) == frames.OtherFrame(
        "token_needed"
    )

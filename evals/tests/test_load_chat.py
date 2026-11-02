"""A simulated widget user (diletta_evals.load.chat) against a fake widget socket: the whole walk (mint, bootstrap, upgrade,
conversation frame, host token, turns, a rating), the gate that holds every chat open together, and the failures that
must be reported, not raised."""

import asyncio
import json
from collections.abc import Awaitable, Callable

import httpx
from websockets import Subprotocol
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from diletta_evals.config import TestHostSettings as HostSettings
from diletta_evals.load.chat import ChatPlan, RunState, UserResult, run_user
from diletta_evals.load.config import LoadSettings
from diletta_evals.load.constants import (
    CHAT_REQUEST_FRAME_TYPE,
    CHAT_RESPONSE_FRAME_TYPE,
    FEEDBACK_FRAME_TYPE,
    HOST_TOKEN_FRAME_TYPE,
    WIDGET_SUBPROTOCOL,
)

ORIGIN = "https://app.example.com"


def settings_for(port: int) -> LoadSettings:
    return LoadSettings(
        api_url=f"http://127.0.0.1:{port}",
        private_jwk={},
        company_id="co_1",
        connection_id="cn_1",
        test_host=HostSettings(issuer="https://host.example", admin_secret="secret"),
        origin=ORIGIN,
        chatbot_id="bot_1",
    )


def plan_for(users: int, *, turns: int = 2, rate_down_users: int = 0) -> ChatPlan:
    return ChatPlan(
        users=users,
        turns=turns,
        think_seconds=0,
        ramp_seconds=0,
        rate_down_users=rate_down_users,
        workspace="ws_test",
        turn_timeout_seconds=5,
        connect_timeout_seconds=5,
        gate_timeout_seconds=10,
    )


class FakeHost:
    """The mint and the bootstrap, answered in-process."""

    def __init__(self, bootstrap_status: int = 200, failing_mint_user: str | None = None) -> None:
        self.minted: list[str] = []
        self.bootstrap_status = bootstrap_status
        self.failing_mint_user = failing_mint_user

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/auth/tokens":
            user = json.loads(request.content)["sub"]
            if user == self.failing_mint_user:
                return httpx.Response(500)
            self.minted.append(user)
            return httpx.Response(201, json={"companionJwt": f"jwt.{user}", "hostToken": f"host.{user}", "expiresAt": 1})
        if request.url.path == "/widget/bootstrap":
            assert request.headers["Origin"] == ORIGIN
            return httpx.Response(self.bootstrap_status, json={"isSuccess": True})
        return httpx.Response(404)


Handler = Callable[[ServerConnection], Awaitable[None]]


def chat_server(
    *, answer: bool = True, notice: str | None = None, refuse_upgrade: bool = False
) -> tuple[Handler, list[dict[str, object]]]:
    """A widget socket: the conversation frame on connect; each chat request answered with start, a delta and done."""
    received: list[dict[str, object]] = []

    async def handler(connection: ServerConnection) -> None:
        await connection.send(
            json.dumps({"type": "conversation", "conversation": {"publicId": "cv_1"}, "chatbot": {}, "feedback": []})
        )
        async for raw in connection:
            frame = json.loads(raw)
            received.append(frame)
            if frame["type"] == CHAT_REQUEST_FRAME_TYPE:
                if notice is not None:
                    await connection.send(json.dumps({"type": notice, "message": "Temporarily unavailable"}))
                    continue
                if not answer:
                    continue
                for body, done in [
                    (json.dumps({"type": "start", "messageId": "msg_1"}), False),
                    (json.dumps({"type": "text-delta", "delta": "Hi"}), False),
                    ("", True),
                ]:
                    await connection.send(
                        json.dumps({"type": CHAT_RESPONSE_FRAME_TYPE, "id": frame["id"], "body": body, "done": done})
                    )
            elif frame["type"] == FEEDBACK_FRAME_TYPE:
                await connection.send(
                    json.dumps({"type": "feedback", "messageId": frame["messageId"], "rating": frame["rating"]})
                )

    return handler, received


async def refuse_with_503(_connection: ServerConnection, _request: Request) -> Response:
    return Response(503, "Service Unavailable", Headers({"Content-Type": "text/plain"}), b"down")


async def run_users(
    handler: Handler,
    plan: ChatPlan,
    host: FakeHost,
    *,
    process_request: Callable[[ServerConnection, Request], Awaitable[Response | None]] | None = None,
) -> tuple[list[UserResult], RunState]:
    async with serve(
        handler,
        "127.0.0.1",
        0,
        subprotocols=[Subprotocol(WIDGET_SUBPROTOCOL)],
        process_request=process_request,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        state = RunState(plan)
        async with httpx.AsyncClient(transport=httpx.MockTransport(host.handle)) as http:
            results = await asyncio.gather(
                *(run_user(index, settings=settings_for(port), http=http, state=state) for index in range(plan.users))
            )
    return list(results), state


def test_users_walk_the_widgets_path_and_all_chats_are_open_together() -> None:
    handler, received = chat_server()
    host = FakeHost()
    results, state = asyncio.run(run_users(handler, plan_for(6, turns=2, rate_down_users=2), host))

    assert sorted(host.minted) == [f"load-user-{index}" for index in range(6)]
    assert all(result.is_connected and result.failure is None for result in results)
    assert all(len(result.turns) == 2 and all(turn.is_ok for turn in result.turns) for result in results)
    assert all(turn.first_chunk_ms is not None for result in results for turn in result.turns)
    assert state.chats.peak == 6
    assert state.chats.open == 0
    assert state.server_errors == 0

    # DEV_NOTE: The first two users rated their first reply down, and the fake saved it
    assert [result.is_rating_saved for result in results] == [True, True, False, False, False, False]
    assert sum(1 for frame in received if frame["type"] == HOST_TOKEN_FRAME_TYPE) == 6
    assert sum(1 for frame in received if frame["type"] == CHAT_REQUEST_FRAME_TYPE) == 12
    assert sorted(str(frame["token"]) for frame in received if frame["type"] == HOST_TOKEN_FRAME_TYPE) == sorted(
        f"host.load-user-{index}" for index in range(6)
    )


def test_a_turn_the_chatbot_cant_answer_is_reported_and_ends_that_chat() -> None:
    handler, _ = chat_server(notice="unavailable")
    results, state = asyncio.run(run_users(handler, plan_for(2, turns=3), FakeHost()))

    for result in results:
        assert len(result.turns) == 1
        assert not result.turns[0].is_ok
        assert result.turns[0].failure == "unavailable: Temporarily unavailable"
        assert result.failure is not None and result.failure.startswith("Turn 1")
    assert state.chats.open == 0


def test_a_turn_that_gets_no_answer_times_out() -> None:
    handler, _ = chat_server(answer=False)
    plan = ChatPlan(**{**plan_for(1, turns=1).__dict__, "turn_timeout_seconds": 0.3})
    results, _ = asyncio.run(run_users(handler, plan, FakeHost()))
    assert results[0].turns[0].failure == "no answer in time"


def test_a_refused_upgrade_is_a_server_error_and_does_not_hold_the_others_at_the_gate() -> None:
    handler, _ = chat_server()
    results, state = asyncio.run(run_users(handler, plan_for(3, turns=1), FakeHost(), process_request=refuse_with_503))

    assert all(not result.is_connected for result in results)
    assert all(result.failure == "The upgrade was refused: HTTP 503" for result in results)
    assert state.server_errors == 3
    assert state.chats.peak == 0


def test_a_bootstrap_that_fails_is_counted_when_it_is_a_5xx() -> None:
    handler, _ = chat_server()
    results, state = asyncio.run(run_users(handler, plan_for(2, turns=1), FakeHost(bootstrap_status=502)))
    assert all(result.failure == "The bootstrap failed" for result in results)
    assert state.server_errors == 2

    _, refused = asyncio.run(run_users(handler, plan_for(2, turns=1), FakeHost(bootstrap_status=403)))
    assert refused.server_errors == 0


def test_a_user_that_cant_connect_leaves_the_rest_to_chat_with_a_lower_peak() -> None:
    handler, _ = chat_server()
    host = FakeHost(failing_mint_user="load-user-1")
    results, state = asyncio.run(run_users(handler, plan_for(3, turns=1), host))

    assert [result.is_connected for result in results] == [True, False, True]
    assert state.chats.peak == 2
    assert state.server_errors == 1

"""One simulated widget user (M6-5): the widget's own path, as the widget walks it. The host mints the user's companion JWT,
the bootstrap is read, the socket opens (GET /widget/ws, the JWT in Sec-WebSocket-Protocol), the conversation frame
arrives, the host token is sent, and the user sends turns one at a time, waiting for each answer; a few rate their first
reply down, which writes a critical event (the outbox lag the run measures). Every user waits at a gate after connecting
until all have, so the chats really are open together.

A failure ends that user's chat and is reported; it never raises. A 5xx from the backend (the bootstrap, the upgrade, the
token mint) is counted apart, because the load test's target is none.
"""

import asyncio
import secrets
import time
from dataclasses import dataclass, field

import httpx
from websockets import Subprotocol
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

from diletta_evals.load import frames
from diletta_evals.load.config import LoadSettings
from diletta_evals.load.constants import FEEDBACK_RATING_DOWN, WIDGET_SUBPROTOCOL
from diletta_evals.load.hosts import MintError, mint_tokens


@dataclass(frozen=True)
class ChatPlan:
    users: int
    turns: int
    # Seconds between a user's turns. A user may send userMessagesPerMinute (10 by default) a minute, so under 6.5
    think_seconds: float
    # The users' connects are spread over this many seconds
    ramp_seconds: float
    # How many users (the first ones) rate their first reply down
    rate_down_users: int
    workspace: str
    turn_timeout_seconds: float = 90.0
    connect_timeout_seconds: float = 60.0
    # The longest the gate waits for the others: their ramp and their own connect
    gate_timeout_seconds: float = 180.0


@dataclass
class TurnResult:
    is_ok: bool
    total_ms: float
    first_chunk_ms: float | None = None
    failure: str | None = None


@dataclass
class UserResult:
    index: int
    is_connected: bool = False
    turns: list[TurnResult] = field(default_factory=list)
    is_rating_expected: bool = False
    is_rating_saved: bool = False
    failure: str | None = None


class OpenChats:
    """How many chats are open at once, and the most there were."""

    def __init__(self) -> None:
        self.open = 0
        self.peak = 0

    def enter(self) -> None:
        self.open += 1
        self.peak = max(self.peak, self.open)

    def leave(self) -> None:
        self.open -= 1


class RunState:
    """What every user of a run shares: the gate, the open-chat gauge and the count of the backend's own failures."""

    def __init__(self, plan: ChatPlan) -> None:
        self.plan = plan
        self.chats = OpenChats()
        self.server_errors = 0
        self._arrived = 0
        self._gate = asyncio.Event()

    def arrive(self) -> None:
        """A user's connect is over, whether it worked or not; the gate opens when all of them are."""
        self._arrived += 1
        if self._arrived >= self.plan.users:
            self._gate.set()

    async def wait_at_gate(self) -> bool:
        try:
            await asyncio.wait_for(self._gate.wait(), self.plan.gate_timeout_seconds)
        except TimeoutError:
            return False
        return True


def websocket_base(api_url: str) -> str:
    return api_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)


async def run_user(
    index: int, *, settings: LoadSettings, http: httpx.AsyncClient, state: RunState
) -> UserResult:
    plan = state.plan
    result = UserResult(index=index, is_rating_expected=index < plan.rate_down_users)
    # DEV_NOTE: Spread the connects over the ramp, so 50 upgrades don't land in the same millisecond
    await asyncio.sleep(plan.ramp_seconds * index / max(1, plan.users))
    arrived = False
    try:
        tokens = await mint_tokens(
            http, settings.test_host, workspace=plan.workspace, user=f"load-user-{index}"
        )
        if not await _read_bootstrap(http, settings, tokens.companion_jwt, state):
            result.failure = "The bootstrap failed"
            return result
        async with _open_socket(settings, tokens.companion_jwt, plan) as socket:
            await _wait_for_conversation(socket, plan.connect_timeout_seconds)
            await socket.send(frames.host_token_frame(tokens.host_token))
            result.is_connected = True
            state.arrive()
            arrived = True
            if not await state.wait_at_gate():
                result.failure = "The other chats never all connected"
                return result
            state.chats.enter()
            try:
                await _chat(socket, result, plan)
            finally:
                state.chats.leave()
    except MintError as error:
        if error.status >= 500 or error.status == 0:
            state.server_errors += 1
        result.failure = f"Token mint: {error}"
    except InvalidStatus as error:
        if error.response.status_code >= 500:
            state.server_errors += 1
        result.failure = f"The upgrade was refused: HTTP {error.response.status_code}"
    except (WebSocketException, OSError, TimeoutError) as error:
        result.failure = f"{type(error).__name__}: {error}"
    finally:
        if not arrived:
            state.arrive()
    return result


async def _read_bootstrap(
    http: httpx.AsyncClient, settings: LoadSettings, companion_jwt: str, state: RunState
) -> bool:
    query = {"chatbot": settings.chatbot_id} if settings.chatbot_id else None
    try:
        response = await http.get(
            f"{settings.api_url}/widget/bootstrap",
            headers={"Authorization": f"Bearer {companion_jwt}", "Origin": settings.origin},
            params=query,
            timeout=30.0,
        )
    except httpx.HTTPError:
        state.server_errors += 1
        return False
    if response.status_code >= 500:
        state.server_errors += 1
    return response.status_code == 200


def _open_socket(settings: LoadSettings, companion_jwt: str, plan: ChatPlan):  # noqa: ANN202
    uri = f"{websocket_base(settings.api_url)}/widget/ws"
    if settings.chatbot_id:
        uri += f"?chatbot={settings.chatbot_id}"
    return connect(
        uri,
        subprotocols=[Subprotocol(WIDGET_SUBPROTOCOL), Subprotocol(companion_jwt)],
        additional_headers={"Origin": settings.origin},
        open_timeout=plan.connect_timeout_seconds,
        max_size=2**22,
        proxy=None,
    )


async def _wait_for_conversation(socket: ClientConnection, timeout_seconds: float) -> None:
    async with asyncio.timeout(timeout_seconds):
        while True:
            frame = frames.parse_frame(await socket.recv())
            if isinstance(frame, frames.ConversationFrame):
                return
            if isinstance(frame, frames.NoticeFrame):
                raise WebSocketException(f"{frame.kind}: {frame.message}")


async def _chat(socket: ClientConnection, result: UserResult, plan: ChatPlan) -> None:
    assistant_message_id: str | None = None
    for turn_number in range(plan.turns):
        if turn_number > 0:
            await asyncio.sleep(plan.think_seconds)
        turn, message_id = await _turn(
            socket,
            text=f"Load test message {turn_number + 1} from user {result.index}. How do I reset my password?",
            timeout_seconds=plan.turn_timeout_seconds,
        )
        result.turns.append(turn)
        if not turn.is_ok:
            result.failure = f"Turn {turn_number + 1}: {turn.failure}"
            return
        if turn_number == 0:
            assistant_message_id = message_id
        if turn_number == 0 and result.is_rating_expected and assistant_message_id:
            result.is_rating_saved = await _rate_down(socket, assistant_message_id)


async def _turn(
    socket: ClientConnection, *, text: str, timeout_seconds: float
) -> tuple[TurnResult, str | None]:
    request_id = secrets.token_hex(6)
    started = time.monotonic()
    first_chunk_ms: float | None = None
    message_id: str | None = None

    def elapsed_ms() -> float:
        return (time.monotonic() - started) * 1000

    try:
        async with asyncio.timeout(timeout_seconds):
            await socket.send(
                frames.chat_request_frame(
                    request_id=request_id, message_id=f"load-{secrets.token_hex(8)}", text=text
                )
            )
            while True:
                frame = frames.parse_frame(await socket.recv())
                if isinstance(frame, frames.NoticeFrame):
                    return TurnResult(False, elapsed_ms(), first_chunk_ms, f"{frame.kind}: {frame.message}"), None
                if not isinstance(frame, frames.ChatChunkFrame) or frame.request_id != request_id:
                    continue
                if frame.error is not None:
                    return TurnResult(False, elapsed_ms(), first_chunk_ms, f"stream error: {frame.error}"), None
                if first_chunk_ms is None and frame.chunk_type:
                    first_chunk_ms = elapsed_ms()
                if frame.message_id and message_id is None:
                    message_id = frame.message_id
                if frame.is_done:
                    return TurnResult(True, elapsed_ms(), first_chunk_ms), message_id
    except TimeoutError:
        return TurnResult(False, elapsed_ms(), first_chunk_ms, "no answer in time"), None
    except ConnectionClosed as error:
        return TurnResult(False, elapsed_ms(), first_chunk_ms, f"socket closed ({error.rcvd.code if error.rcvd else '?'})"), None


async def _rate_down(socket: ClientConnection, message_id: str) -> bool:
    """Rates the reply down and waits for the DO's ack: True when it saved the rating."""
    try:
        async with asyncio.timeout(20.0):
            await socket.send(frames.feedback_frame(message_id=message_id, rating=FEEDBACK_RATING_DOWN))
            while True:
                frame = frames.parse_frame(await socket.recv())
                if isinstance(frame, frames.FeedbackFrame) and frame.message_id == message_id:
                    return frame.rating == FEEDBACK_RATING_DOWN
                if isinstance(frame, frames.NoticeFrame):
                    return False
    except (TimeoutError, ConnectionClosed):
        return False

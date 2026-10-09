# ADR 0001: Widget auth before the WebSocket upgrade

- Status: Accepted
- Date: 2026-10-09
- Task: M2-2 (Conversation DO on Think)
- Changes: Architecture baseline, "Edge and identity": "Widget talks over WebSocket, JWT sent as the first message."

## Context

M2-1 authenticated the widget in-band: the worker accepted the socket, waited for `{type:"auth", token}` as the first message, and closed with a 44xx code on failure. The plan was for M2-2 to move the socket into the Conversation DO and run the same check on its first message.

Reading `@cloudflare/think` 0.19.0 / `agents` 0.24.0 (pinned) showed that cannot be done safely inside the DO:

- When a socket connects, Think sends the whole transcript (`cf_agent_chat_messages`) before any subclass code runs. There is no option to turn it off.
- Think handles its chat frames (`cf_agent_use_chat_request`, `cf_agent_chat_clear`, …) itself, before a subclass's `onMessage`. A socket that hasn't authenticated could still start turns or clear the transcript.
- Chat broadcasts go to every connection.

Gating all of this would mean rewrapping Think's private handlers, which could break silently on any Think upgrade, and a missed change would leak transcripts.

## Decision

The widget authenticates before the upgrade, in the worker:

1. The widget opens `GET /widget/ws?chatbot=&conversation=` and offers the subprotocols `['diletta.v1', <companion JWT>]`. The token travels in the `Sec-WebSocket-Protocol` header: never in the URL (URLs land in logs and history), and never echoed back, since the server selects `diletta.v1` only.
2. The worker runs the M2-1 checks unchanged (`WidgetAuthRepo.authenticate`: algorithm allowlist, issuer → connection, JWKS signature, claims, origin, company and chatbot). Then `ConversationsRepo.startOrResume` either creates the conversation or checks that the one being resumed is the user's own, open conversation.
3. A failure is an HTTP answer to the upgrade, with a generic body and no socket. The statuses replace the 44xx close codes:
   - 401: token rejected
   - 403: not allowed
   - 404: unknown chatbot, or a conversation that isn't theirs or is closed
   - 500: server error
4. Only then does the worker forward the upgrade to the Conversation DO (`getAgentByName`). It sends a fresh header set that includes the verified session in a header only the worker sets. The DO has no public route, so it only ever holds verified sockets.
5. The DO still filters every inbound frame (`webSocketMessage`). Authentication no longer depends on that filter; it exists so a client can't rewrite or clear the transcript, register tools, or set state.

## Consequences

- The M2-1 guarantees are kept: the same checks in the same order, the token never in a URL or a log, and no oracle (every pre-signature failure is still `Unauthorized`).
- The M2-1 first-message protocol, its 10-second auth timeout and `WidgetCloseCodeEnum` are removed. The widget (M2-7) reads an HTTP status on a failed upgrade instead of a close code.
- Browsers send `Sec-WebSocket-Protocol` from `new WebSocket(url, protocols)`. JWT characters are all valid in a subprotocol token.
- Some proxies log request headers. The token lives at most 5 minutes, and the same exposure applied to the first message.
- Conversation start and resume run in the worker, so the DO never creates a conversation for an unverified caller.

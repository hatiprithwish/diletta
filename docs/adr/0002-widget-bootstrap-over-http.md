# ADR 0002: Widget bootstrap over HTTP, next to the WebSocket

- Status: Accepted
- Date: 2026-10-10
- Task: M2-7 (widget UI)
- Changes: Architecture baseline, "Edge and identity": "Widget talks over WebSocket" gains one read-only HTTP call. Amends ADR 0001 on how the widget reads a refused upgrade.

## Context

Before a visitor writes anything, the widget has to show two things:

- the launcher's label, and
- the welcome screen: the chatbot's name, its greeting and up to three suggestions, from the published config (`ConfigWidgetV1`).

Today that data could only come over the socket. But opening `GET /widget/ws` creates a conversation row: `ConversationsRepo.startOrResume` writes the chatbot user, the conversation and its `conversation.started` event. Opening the socket on page load, or even when the panel opens, would therefore leave a conversation behind for every visitor who never writes.

ADR 0001 also assumed the widget could read the HTTP status of a refused upgrade. Browsers can't: a failed `new WebSocket(...)` shows up only as a close with code 1006.

## Decision

1. The worker gets `GET /widget/bootstrap?chatbot=`, which reads only. It returns the chatbot's `{ publicId, name }` and its widget settings `{ greeting, suggestions, launcherLabel }` from the published config, read through `loadConfigSpec`. When no published config can be loaded, `widget` is null and the widget shows its unavailable state.
2. It takes the same companion JWT, sent as `Authorization: Bearer`, never in the URL. It goes through the same `WidgetAuthRepo.authenticate`, with the same order, statuses and generic bodies as `/ws`. It creates no chatbot user, conversation or event.
3. CORS for `/widget/*` is set by the widget routes, not the dashboard's global allowlist, because which origins are allowed is decided per connection. The rules for `/widget/bootstrap`:
   - CORS answers any origin, never with credentials, and allows only the `Authorization` header.
   - The data itself is gated by `allowed_origins`, through `authenticate`. A token whose connection doesn't list the request's `Origin` gets 403.
4. The widget opens the socket only for a first message, or when the panel opens on a conversation saved in this browser. A new conversation's id comes back in the `conversation` frame. The widget saves it and reconnects with it once, before sending anything, so a later reconnect resumes that conversation.
5. A refused upgrade is handled by counting connects that close before they open:
   - after 2, a saved conversation is dropped and the widget goes back to a new chat, idle: a new conversation opens only when the visitor sends a message (so a return visit after auto-close creates nothing);
   - after 5 failed connects of any kind (a `getToken` failure counts, but never drops a saved conversation), the widget shows "temporarily unavailable".

## Consequences

- An idle page view costs one authenticated read and leaves no rows.
- A second endpoint takes the companion JWT. Its token handling matches `/ws` exactly (pattern rule 3.22), so it adds no new oracle.
- A host's origin can read a 401/403/404 status cross-origin. The body is generic, as it is for `/ws`.
- The widget can't tell 401 from 404 on a refused upgrade, so a resume the server refuses costs two failed connects before the widget falls back to a new chat.

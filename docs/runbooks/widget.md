# Widget

The chat widget (`apps/widget`, M2-7) is what a host page's users chat in. It renders in a Shadow DOM, so the host's CSS can't reach it and its own CSS can't leak out. Its theme follows the host (light or dark).

Before any conversation exists, it reads its settings from `GET /widget/bootstrap`. It chats over `GET /widget/ws` (ADR 0001, ADR 0002).

## Embedding it

A host has two ways in. Both take the same options (`Schemas.WidgetInitOptions`):

| Option     | Required | What it is                                                                                   |
| ---------- | -------- | -------------------------------------------------------------------------------------------- |
| `apiBase`  | yes      | The platform worker's origin, e.g. `https://diletta-worker.example.workers.dev` (https only) |
| `getToken` | yes      | `() => Promise<string>`: asks the host's own backend for a fresh companion JWT (≤ 5 minutes) |
| `chatbot`  | no       | A chatbot publicId; when absent, the company's default chatbot is used                       |
| `theme`    | no       | `"light"` (default) or `"dark"`                                                              |

**Script tag.** The static Worker in `apps/widget/wrangler.jsonc` serves the bundle (`diletta-widget.js`).

```html
<script src="https://<widget host>/diletta-widget.js"></script>
<script>
  const widget = window.Diletta.init({
    apiBase: "https://<platform worker>",
    getToken: () => fetch("/api/companion-token").then((response) => response.text()),
    theme: "light",
  });
  // window.Diletta.open() / close() / setTheme("dark") / destroy() act on the same widget
</script>
```

`init` throws on bad options. Calling it a second time replaces the first widget.

**React.** Use `<DilettaWidget apiBase=… getToken=… theme=… />`, exported from `apps/widget/src/index.ts`. `vite build --mode lib` builds it to `dist/lib/index.js`, with React external. A new `theme` re-themes the widget in place; a new `apiBase` or `chatbot` starts a fresh one.

**What the host sets up:**

- A company connection whose `jwt_issuer` is the host's issuer. The host serves its JWKS at `{iss}/.well-known/jwks.json`.
- The host page's origin in that connection's `allowed_origins`.
- A token endpoint that `getToken` calls.

## What it does

- **Page load.** The widget makes one bootstrap read with a fresh token: the chatbot's name, the greeting, up to 3 suggestions and the launcher label. It opens no socket, so idle visitors create no conversations.
- **First message.** The socket opens with no conversation. The server creates one and names it in the `conversation` frame. The widget saves the id in `localStorage`, keyed by platform, chatbot and host user (the token's `sub`). It reconnects once with that id, then sends the message.
- **Reload.** Opening the panel resumes the saved conversation. The server sends the transcript and the ratings already given.
- **New chat.** Clears the saved id and shows the welcome screen. The old conversation closes on its own after 30 minutes idle.
- **Every connect** gets a fresh token through `getToken`, sent in `Sec-WebSocket-Protocol`. Tokens are never stored.

**The greeting.** Its first line is the welcome heading; any following lines are the paragraph under it.

**Feedback.** Thumbs up or down on a finished reply. The visitor can switch, but not clear. They're stored in `feedback` (one row per reply per user). M2-8 opens the quality issue for a thumbs-down.

## Troubleshooting

**The widget says "Temporarily unavailable".**

- On open, before any message: the bootstrap read failed or the chatbot has no published config. Check the browser's network tab for `/widget/bootstrap`:
  - 401: token rejected (issuer, signature, `aud`, lifetime).
  - 403: origin not in `allowed_origins`, connection disabled, or company or chatbot paused.
  - 404: chatbot not found.
  - 200 with `widget: null`: no published config.
- After a message: the DO answered `unavailable`, for example no model key, a provider failure, or a budget refusal (see `docs/runbooks/budget.md` and `ai-gateway.md`).
- After five failed connects: the socket upgrade keeps being refused. A browser can't read the upgrade's status, so test `/widget/bootstrap` with the same token. It runs the same checks.

**A conversation won't resume.** After two refused connects the widget drops the saved id and starts a new conversation. That's expected when the old one closed after idling.

**The widget looks wrong on a host page.** All its styles live in its shadow root. It puts only two things in the host's `<head>`: Tailwind's `@property` rules (`#diletta-widget-properties`) and the Google Fonts stylesheet (`#diletta-widget-fonts`).

## Bundle size

`pnpm --filter widget build` fails when `diletta-widget.js` is over `WIDGET_BUNDLE_MAX_GZIP_BYTES` (200 KiB gzipped). It was 170.7 KiB at M2-7.

The biggest parts are React DOM, zod, `cn`, the agents client (including its unused capnweb transport) and `ai`. Markdown is the widget's own small parser (`src/lib/markdown.ts`) rather than a library, to stay within the budget.

## Local development

The dev host (`pnpm dev:widget`, http://localhost:5174) is a stand-in host page with the live widget. Add `?gallery` to see every widget state drawn from sample data, and `&theme=dark` for dark mode. The gallery needs no backend and is what the light and dark screenshots are taken from.

To chat for real, the dev host signs its own tokens, so it needs a one-time setup against a staging company:

```bash
pnpm --filter widget dev:setup --company <companyPublicId>
pnpm dev:backend   # http://localhost:8787
pnpm dev:widget
```

`dev:setup` does three things:

- Creates a local ES256 key and a dev issuer of its own (`apps/widget/.dev/dev-key.json`, gitignored).
- Registers the issuer as an active staging connection of that company, allowing origin `http://localhost:5174`. It writes as the owner role (`DATABASE_URL` in `apps/backend/.env`), like test fixtures do.
- Seeds the issuer's JWKS into the local backend's `JWKS_CACHE`, because the dev issuer serves none.

It then lists anything the company still lacks for a chat: an active default chatbot, a published config, an active model key. Run it again if you clear `apps/backend/.wrangler`.

## Deploying

The `deploy-widget-staging` and `deploy-widget-production` workflows build the widget and run `wrangler deploy --env staging|production`. They run on a push to `staging` or `main` that touches `apps/widget/**`, `packages/ui/**` or `packages/schemas/**`.

The bundle is served with a 5-minute cache, so hosts pick up a release within minutes.

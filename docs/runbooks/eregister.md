# eRegister

eRegister is the first customer host (M7). This runbook covers its connection to Diletta (M7-1), its tools (M7-2), and the widget in eRegister's app with the internal pilot (M7-5).

For now, eRegister runs only against **Diletta staging**, through its own eRegister env `ai-agent`. That env is a separate backend Worker and a separate frontend Pages project. It reuses the eRegister `test` env's database, KV, R2, queues, sandbox and Firebase project (`digital-registers-test`). The `test` and `feature` envs are not changed. There's no production connection yet; that comes with M7-6.

| Piece           | Where                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| eRegister API   | `https://eregister-backend-ai-agent.wit-by-bit-nikhil.workers.dev` (wrangler `--env ai-agent`)                 |
| eRegister app   | `https://eregister-ai-agent-1ms.pages.dev` (Pages project `eregister-ai-agent`; the plain subdomain was taken) |
| Diletta backend | `https://diletta-worker-staging.hatiprithwish.workers.dev`                                                     |
| Diletta company | eRegister, created with `POST /operator/companies`                                                             |
| Connection      | one Staging connection, below                                                                                  |

## How eRegister signs its users in to the widget

The widget needs a **companion JWT** (`Schemas.ZWidgetJwtClaims`): `aud` `diletta-widget`, at most 5 minutes from `iat` to `exp`, RS256 or ES256 with a `kid`, and the issuer's keys at `{iss}/.well-known/jwks.json`. A Firebase ID token fails all of these, so eRegister signs its own:

- `POST /api/p/companies/:companyId/companion/token`. Signed-in users only (eRegister's `checkUserAuth`). It answers `{ token }`: ES256 over `{iss, sub: <Firebase uid>, aud: "diletta-widget", name, iat, exp: iat + 300}`.
- `GET /.well-known/jwks.json` publishes the public key.
- The private key is the Worker secret `COMPANION_JWT_SIGNING_KEY`, a private JWK with its `kid`. Without it, both routes answer 404, so the other eRegister envs are unchanged.

`iss` is the env's `EREG_BACKEND_API_BASE_URL`. It must equal the connection's `jwt_issuer` exactly: no trailing slash.

**Host calls** use `jwt_forward`: the widget's `getHostToken` returns the user's Firebase ID token (`getIdToken()`). The chatbot then reads and changes records as that user, with that user's eRegister role.

**Fallback (not built):** eRegister also has company API tokens (`x-api-key: <clientId>.<apiKey>`, `checkTokenAuth`). They could replace the Firebase token for host calls, but only through an `api_key_header` AuthStrategy in `@app/adapter`, which isn't built yet (`SUPPORTED_AUTH_TYPES`), plus a stored, encrypted company credential. Every tool call would then run with company-wide rights, not the user's. They can't replace the companion JWT, because they carry no user.

## Setup (once)

### 1. eRegister signing key

In `eregister-backend/apps`:

```bash
node scripts/companion-keygen.mjs --kid companion-2026-11 > /tmp/companion.jwk
npx wrangler secret put COMPANION_JWT_SIGNING_KEY --config src/services/api/wrangler.jsonc --env ai-agent < /tmp/companion.jwk
rm /tmp/companion.jwk
```

Keep a copy in the team vault. Check `GET {iss}/.well-known/jwks.json`: it should list one EC key with that `kid` and no `d`.

### 2. Deploy

- Backend: run the `ai-agent-deployment.yml` workflow (`workflow_dispatch`) in `eregister-backend`. It deploys the API Worker with `--env ai-agent`, nothing else. That env keeps `APP_ENV=test`, because an unknown value falls back to production behaviour (live Stripe, production URLs).
- Frontend: create the Pages project `eregister-ai-agent` once. Put the app's `.env` for this env in the GitHub secret `AI_AGENT_ENV`: the `test` Firebase config, with `VITE_backendP` and `VITE_backendQ` set to `https://eregister-backend-ai-agent.wit-by-bit-nikhil.workers.dev`. Then run the `app-ai-agent-deploy.yml` workflow in `eregister-reborn`. It builds with `build:staging` and runs `pages deploy` to `eregister-ai-agent`; the test and prod deploys are untouched.
- In Firebase (project `digital-registers-test`) › Authentication › Settings › Authorized domains, add `eregister-ai-agent-1ms.pages.dev`. Without it, sign-in fails on that origin.

### 3. Diletta company and connection

Sign in to the Diletta dashboard as an operator. Then:

1. Create the company: **Companies › New company** on the operator pages, or `POST /operator/companies`. Both create its encryption key; never insert the row by hand.
2. Create the connection: the company's page › **Connections › Add connection** (Staging, Forward the user's token, the fields below), or the API:

```http
POST /operator/companies/<companyPublicId>/connections
Content-Type: application/json

{
  "companyConnection": {
    "environment": 2,
    "baseUrl": "https://eregister-backend-ai-agent.wit-by-bit-nikhil.workers.dev/api/p/",
    "authType": "jwt_forward",
    "authConfig": {},
    "credentialScope": 1,
    "jwtIssuer": "https://eregister-backend-ai-agent.wit-by-bit-nikhil.workers.dev",
    "allowedOrigins": ["https://eregister-ai-agent-1ms.pages.dev"]
  }
}
```

`environment` 2 is Staging and `credentialScope` 1 is None (`CompanyConnectionEnvironmentIntEnum`, `CompanyConnectionCredentialScopeIntEnum`). There is no `resetOp`: eRegister has no reset API yet, so every eRegister eval case must name its own records with `{case.tag}`. Keep the connection's `publicId` from the answer.

3. Load the tools: the company's page › **Tools › Load tool set** (eRegister, this connection). See [Tools](#tools-m7-2).

The operator connection routes (`CompanyConnectionsRoutes`):

| Route                                                        | What                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /operator/companies/:companyPublicId/connections`       | List the company's connections                                                                                                   |
| `GET /operator/companies/:companyPublicId/connections/:id`   | One connection                                                                                                                   |
| `POST /operator/companies/:companyPublicId/connections`      | Create. `409 IssuerTaken` if another connection (any company) has the issuer                                                     |
| `PATCH /operator/companies/:companyPublicId/connections/:id` | Change base URL, auth config, issuer, origins, reset op or status. `400 Invalid` for a bad auth config or a reset op off Staging |

Environment, adapter, auth type and credential scope never change: for a different value, create a new connection. Each write records an audit row as the operator: Created, Updated, Origins changed, Activated or Disabled. A save that changes nothing records nothing. Company admins get 403 here. They change origins only, on the Security page.

### 4. Test user

In eRegister staging (`ai-agent`, so the test DB), add a user to the eRegister test company with the role the pilot needs. The user signs in with email and password: enable Email/Password in Firebase if it isn't on. Keep the email and password in the vault, and note the user's Firebase **uid**: it is `EVAL_HOST_USER`.

### 5. Eval settings

**Hosted runner (M7-9):** set the test user as the Staging connection's **Test sign-in** on the operator pages (kind eRegister: the Firebase uid, the `digital-registers-test` web API key, the email and the password). Admins then run tests from the dashboard; no local file is needed (`docs/runbooks/evals.md` › Hosted runner).

**CLI (local runs):** in `evals/.env`, or another env file passed with `uv run --project evals --env-file <file> python -m diletta_evals run …` (`pnpm evals:run` reads `evals/.env` only):

| Variable                       | Value                                                      |
| ------------------------------ | ---------------------------------------------------------- |
| `DILETTA_API_URL`              | `https://diletta-worker-staging.hatiprithwish.workers.dev` |
| `DILETTA_COMPANY_ID`           | the eRegister company's public id                          |
| `DILETTA_CONNECTION_ID`        | the connection's public id                                 |
| `EVAL_HOST_KIND`               | `eregister`                                                |
| `EVAL_HOST_USER`               | the test user's Firebase uid                               |
| `EREGISTER_FIREBASE_API_KEY`   | the `digital-registers-test` web API key (`VITE_apiKey`)   |
| `EREGISTER_TEST_USER_EMAIL`    | the test user's email (vault)                              |
| `EREGISTER_TEST_USER_PASSWORD` | the test user's password (vault)                           |
| `EVAL_JWT_PRIVATE_KEY`         | as for every run (`docs/runbooks/evals.md`)                |

The harness signs the test user in through Firebase (`accounts:signInWithPassword`) before the first attempt and again before the hour-long token runs out. It refuses a token whose uid isn't `EVAL_HOST_USER`, because the eval conversation runs as that user. The login error names Firebase's reason (`INVALID_LOGIN_CREDENTIALS`, `USER_DISABLED`…), never the email or password.

## Tools (M7-2)

The chatbot reads and changes eRegister configuration through 48 tools (`Schemas.EREGISTER_TOOL_DEFINITIONS`, `packages/schemas/src/eregister/`). The tools are bindings written in code (which fields a tool sends, how it is read back and undone); each field's schema comes from eRegister's OpenAPI spec (`/api/openapi.json`) and follows it (`docs/runbooks/tool-contracts.md`). Each tool runs as the signed-in user, with that user's eRegister role.

| Area          | Reads                                                                         | Writes                                                       |
| ------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Companies     | `eregister_list_companies` (every other tool needs a `companyId` from it)     | none                                                         |
| Field types   | `eregister_get_field_types` (the list; with `type`, that field's JSON Schema) | none                                                         |
| Registers     | list, get                                                                     | create, update (whole schema), delete                        |
| Code blocks   | list, get (with source)                                                       | create, update (source inline), delete                       |
| Layouts       | list, get (with template text)                                                | create, update (Lexical / HTML template inline), delete      |
| Actions       | list, get                                                                     | create, update (whole action), delete                        |
| Reports       | list, get                                                                     | create, update, delete                                       |
| Report charts | list, get                                                                     | create, update, delete                                       |
| Dashboards    | list, get                                                                     | create, update, delete                                       |
| Widgets       | list, get                                                                     | create, update, delete                                       |
| Buttons       | list, get                                                                     | create, update (name, description, status, priority), delete |
| Entries       | none                                                                          | create (one entry; checked by its External ID)               |

Not tools: running, deploying, triggering, importing, exporting or printing anything.

**What every write does.** Every write needs the user's approval and is read back after the commit:

| Kind   | Read back                      | Undo                                                         | A lost answer                           |
| ------ | ------------------------------ | ------------------------------------------------------------ | --------------------------------------- |
| Create | by the new id: the fields sent | deletes it                                                   | not resent: a person checks it          |
| Update | the fields sent                | puts the read-before values back                             | read back first, then resent or settled |
| Delete | must answer 404                | **none**: eRegister can't recreate a record under its old id | not resent: a person checks it          |

**Entries.** `eregister_create_entry` adds one entry with `POST …/registers/{id}/data` (`data` = the first step's fields by field id, optional `notes`, and `insertId`, the entry's External ID). The model reads the register first and always passes a new unique `insertId`; the read back compares it, since eRegister's answer holds nothing else safe to compare (calculated fields and sequence numbers change `data`, and it returns neither notes nor the register). A create without an `insertId` is Unknown, never a mismatch: a person checks it on the Changes page. Undo deletes the entry by the `pid` in the create's answer. Update and delete are not tools.

A field eRegister reshapes when it is read isn't compared. That covers a register's schema and flow, an action's triggers, roles access and a button's execution config. A register update or an action update still puts the whole read-before record back on undo. A Word (Docx) layout's file can only be uploaded in eRegister.

**eRegister side** (`eregister-backend`, the same `ai-agent` env as M7-1):

- `POST`/`PUT …/code-blocks` take `sourceFiles: [{fileName, content}]` in place of `fileInfo`, and the backend writes them to R2. `GET …/code-blocks/:id?includeSource=true` returns them as `data.sourceFiles`, sorted by name.
- `POST`/`PUT …/layouts` take `content` (Lexical JSON or HTML / Liquid) in place of `fileId`. `GET …/layouts/:id?includeContent=true` returns it as `data.content`.
- `GET …/:mode/field-types[?type=]` answers the field types and one type's JSON Schema.
- Register create and update are validated with `ZCreateRegisterReq`.
- A GET answers 404 only for a record that's gone, deleted registers included, never for a failed read. Without that, a delete couldn't be confirmed.

### Change or add a tool

One tool, by hand: the company's page › **Tools** (`docs/runbooks/operators.md`): open it, **New version**, edit the draft, save, **Make active**. The steps below change them all from code, so the next seed keeps them:

1. A change to an eRegister request body needs nothing here: the schema syncs from the spec (`docs/runbooks/tool-contracts.md`). Change a binding (the fields a tool sends, its readback, undo or approval) in `packages/schemas/src/eregister/EregisterTools.ts` and `EregisterCommon.ts` (`EREGISTER_BODY_FIELDS`). One-time per eRegister connection, set its spec URL (`<eRegister API>/api/openapi.json`) and shaping on the operator pages (Company › Connections › Edit › **OpenAPI spec**), then press **Sync now** on the Connections card. The shaping is `Schemas.EREGISTER_OPENAPI_SHAPING`; paste:

```json
{
  "isDefaultRequired": true,
  "replaceComponents": {
    "FormField": {
      "type": "object",
      "description": "One form field: { id, label, type, isRequired, ... }. Call eregister_get_field_types with the type for its exact shape.",
      "properties": {
        "id": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "type": {
          "type": "string"
        }
      },
      "required": ["id", "label", "type"],
      "additionalProperties": true
    },
    "TableFormField": {
      "type": "object",
      "description": "One form field: { id, label, type, isRequired, ... }. Call eregister_get_field_types with the type for its exact shape.",
      "properties": {
        "id": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "type": {
          "type": "string"
        }
      },
      "required": ["id", "label", "type"],
      "additionalProperties": true
    },
    "ExtendedFormField": {
      "type": "object",
      "description": "One form field: { id, label, type, isRequired, ... }. Call eregister_get_field_types with the type for its exact shape.",
      "properties": {
        "id": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "type": {
          "type": "string"
        }
      },
      "required": ["id", "label", "type"],
      "additionalProperties": true
    },
    "ReviewFormField": {
      "type": "object",
      "description": "One form field: { id, label, type, isRequired, ... }. Call eregister_get_field_types with the type for its exact shape.",
      "properties": {
        "id": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "type": {
          "type": "string"
        }
      },
      "required": ["id", "label", "type"],
      "additionalProperties": true
    },
    "LayoutFormField": {
      "type": "object",
      "description": "One form field: { id, label, type, isRequired, ... }. Call eregister_get_field_types with the type for its exact shape.",
      "properties": {
        "id": {
          "type": "string"
        },
        "label": {
          "type": "string"
        },
        "type": {
          "type": "string"
        }
      },
      "required": ["id", "label", "type"],
      "additionalProperties": true
    }
  }
}
```

2. Store the tools on the connection. On the company's page › **Tools › Load tool set**, pick eRegister and the connection. It loads the set the deployed backend was built with, so deploy the change first. Each tool ends active at its newest version, and each change records an audit row as you. The dialog shows the `{name, version}` pins. The API is `POST /operator/companies/<companyPublicId>/tool-definitions/tool-sets` with `{ "toolSet": "eregister", "connectionPublicId": "<connectionPublicId>" }`.

   It is idempotent. A tool gets a new version only when it changed, so a config pinned to the old version keeps it. It refuses while a tool has a Draft version (an operator is editing it), naming the tools. It refuses a connection that isn't the company's or isn't Active, one with no spec URL, a spec it can't read and a spec with no operation for a tool; a tool that sends a field the spec doesn't name loads, and the answer names it.

   Without the UI (local, before a deploy), the script does the same as the owner role on the staging branch (`apps/backend/.env`), unaudited, like the test host seed:

   ```bash
   pnpm --filter backend eregister:tools --company <companyPublicId> --connection <connectionPublicId>
   ```

3. Pin the `{name, version}` list (the dialog's pins, or the script's output) in the chatbot's config (`tools`). Pin only the tools the chatbot needs: every pinned tool's schema goes into every model call. All 48 come to about 30K tokens.

### Check it works (M7-2 done when)

Every write tool has a readback, and the undo where eRegister allows one. `pnpm --filter @app/schemas test` (`EregisterTools.test.ts`) checks this for every tool: each one saves, its args convert, each write has a readback, creates and updates undo, deletes are marked not undoable, and an update sends only what it compares or restores. On staging, after loading the tools, run one create, update and delete of a button through the widget. Each ends Verified, and undoing the update ends Undone.

## Widget and internal pilot (M7-5)

### The widget in eRegister's app

The eRegister app (`eregister-reborn`, `apps/eregister-app`) mounts the widget in its app shell (`src/components/ai/diletta/DilettaWidget.tsx`, rendered by `AppLayout`). It loads `diletta-widget.js` by script tag and calls `window.Diletta.init`. The widget shows its own floating launcher. eRegister's concept "AI Assistant" panel is a separate thing and stays switched off.

| Option         | What eRegister passes                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiBase`      | `VITE_DILETTA_API_BASE`                                                                                                                                                                                                                     |
| `getToken`     | `POST /api/p/companies/<current company>/companion/token` with the user's Firebase ID token, its `token`                                                                                                                                    |
| `getHostToken` | the user's Firebase ID token (`getIdToken()`, which Firebase refreshes before it expires)                                                                                                                                                   |
| `theme`        | the app's current theme: `dark` when `<html>` has the `.dark` class (eRegister's System setting resolves to it), else `light`                                                                                                               |
| `accent`       | the user's eRegister accent for that theme: `oklch(--primary)` as the fill, `oklch(--primary-foreground)` on it (white if unset), `oklch(--primary-text)` for links and the focus ring, read from `<html>`'s computed style (`hostLook.ts`) |
| `chatbot`      | not passed: the Diletta company's default chatbot                                                                                                                                                                                           |

When the user changes theme or accent, eRegister's `ThemeProvider` updates `<html>`'s `class` / `data-accent`; a `MutationObserver` on those attributes calls `setTheme` and `setAccent`, so the widget re-colours without restarting. Switching company in eRegister starts a fresh widget, and leaving the app shell (sign-out) destroys it. The saved conversation is keyed by Diletta's platform, the chatbot and the Firebase uid, not by the eRegister company. So after a company switch, opening the panel resumes the same chat. The tools pick the eRegister company by `companyId`, so state the company in the chat when it matters, or start a new chat.

It is on only in a build that sets both variables. They live only in the `AI_AGENT_ENV` GitHub secret of `eregister-reborn`, so the test and production builds don't load the widget. Every eRegister company in the ai-agent env gets the launcher. They all chat with the one eRegister company in Diletta, and the chatbot sees only what the signed-in user can see.

| Variable                  | Value (Diletta staging)                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `VITE_DILETTA_WIDGET_URL` | `https://diletta-widget-staging.hatiprithwish.workers.dev/diletta-widget.js` |
| `VITE_DILETTA_API_BASE`   | `https://diletta-worker-staging.hatiprithwish.workers.dev`                   |

Add both to `AI_AGENT_ENV`, then push to `ai-agent-pages` or run `app-ai-agent-deploy.yml` by hand. The variables are read at build time, so a change needs a new deploy.

Only `https://eregister-ai-agent-1ms.pages.dev` is in the connection's `allowed_origins`. A Pages preview URL (`<hash>.eregister-ai-agent-1ms.pages.dev`) gets 403 on `/widget/bootstrap`. Pilot on the main URL.

**Before the pilot**, check each of these on Diletta staging:

- The Staging connection is Active, with the origin above.
- The tools are loaded and the chatbot's config pins the ones the pilot needs (at least `eregister_list_companies` and the button tools).
- The knowledge sources are synced (M7-3).
- The chatbot is the company's default and has a Published config whose gate run passed (M7-4).
- The company has an active model key and room in its budget (`docs/runbooks/model-keys.md`, `budget.md`).

### Pilot

Pilot users are our own team, each signed in to `https://eregister-ai-agent-1ms.pages.dev` with their own eRegister account in an eRegister test company. The chatbot acts with that account's eRegister role. Each user runs the tasks below in the widget alone, with no engineer helping. Use a register made for the pilot, so nothing in it matters.

| #   | Task                                                                                              | Done when                                                                                      |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Ask how to do something in eRegister (for example how a register button works)                    | The answer cites a help source                                                                 |
| 2   | Ask which registers the company has, then which buttons one of them has                           | The lists match eRegister                                                                      |
| 3   | Ask it to add a button to the pilot register, and approve                                         | The card ends Verified and the button shows in eRegister                                       |
| 4   | Ask it to rename that button. Before approving, use **Edit** to change the new name, then approve | The card returns to approval with the edited diff, ends Verified, and eRegister shows the edit |
| 5   | Undo that rename                                                                                  | The card ends Undone and eRegister shows the old name                                          |
| 6   | Ask it to change the button's description, and reject                                             | Nothing changes in eRegister                                                                   |
| 7   | Ask it to delete the button, and approve                                                          | The card says it can't be undone, ends Verified, and the button is gone                        |
| 8   | Reload the page mid-chat, then open the widget                                                    | The chat resumes with its history                                                              |
| 9   | Rate replies: thumbs up on a good one, thumbs down on a weak one                                  | The thumbs-down shows as an issue on the Quality page                                          |

While the pilot runs, an operator watches it from the Diletta dashboard, acting in the eRegister company (ADR 0006, `docs/runbooks/operators.md`). Check the Conversations, Changes (nothing left as "needs a person"), Quality and Knowledge (doc gaps) pages. A task that needed help, or ended other than its "done when", becomes a Quality issue and gets fixed before the user runs it again: change the config, the knowledge or a tool, and publish again through the gate.

Record each pilot user's run in the M7-5 tracking issue: the user, their eRegister role, the date, the tasks done unaided, and the Quality issues raised. **M7-5 is done** when every pilot user has done all nine tasks unaided on the current Published config. That ticks the launch readiness box "Pilot users completed real tasks on staging without engineer help".

**For M7-6 (production):** the test and production eRegister apps are hosted on Firebase, with a Content-Security-Policy in `apps/eregister-app/firebase.json`. That policy must allow the widget's script host (`script-src`), the platform worker over `https:` and `wss:` (`connect-src`), and Google Fonts (`style-src` `https://fonts.googleapis.com`, `font-src` `https://fonts.gstatic.com`). The Pages ai-agent app sets no CSP.

## Check it works (M7-1 done when)

1. **Staging eval JWT works.** Run `pnpm evals:run --config <any config publicId of the company>`. The harness signs in to Firebase, then starts a run. Any answer past auth shows the eval JWT and the connection were accepted. Before M7-2 and M7-4 add tools and cases, that answer is likely a 400 `Invalid` (no active case). A 401 means the key (see `docs/runbooks/evals.md`), and a 403 means the connection isn't Staging or isn't Active.
2. **Production rejects it.** An eval JWT that names a production connection is 403 before anything is read (`authenticateEval`; `evalHarness.test.ts` "answers 401 without a valid platform signature, 403 for a production or unknown connection"). eRegister's production connection comes with M7-6. Repeat the check against it then.
3. **Companion JWT.** Signed in on `https://eregister-ai-agent-1ms.pages.dev`, `POST {iss}/api/p/companies/<id>/companion/token` answers a token whose header has `alg` ES256 and the `kid`, and whose claims have `iss` = the connection's issuer, `aud` `diletta-widget` and `exp - iat` = 300. The widget itself is embedded in M7-5 (see [Widget and internal pilot](#widget-and-internal-pilot-m7-5)).

## Troubleshooting

| Symptom                                                                           | Likely cause                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness: "eRegister test user sign-in failed: HTTP 400 INVALID_LOGIN_CREDENTIALS" | Wrong email or password, or Email/Password sign-in is off in Firebase                                                                                               |
| Harness: "uid is not EVAL_HOST_USER"                                              | `EVAL_HOST_USER` holds the email or another user's uid                                                                                                              |
| Widget: every connect refused as an unknown issuer                                | The connection's `jwt_issuer` and the token's `iss` differ (a trailing slash, the wrong env)                                                                        |
| Widget: signature refused                                                         | `COMPANION_JWT_SIGNING_KEY` was rotated and the JWKS cache hasn't refetched yet (within a minute), or the JWKS route answers 404 (secret missing)                   |
| A write ends "needs a person" right after a create or a delete                    | eRegister's answer was lost: check the record in eRegister, then resolve it on the Changes page                                                                     |
| Every update of one kind ends Changes undone                                      | eRegister stores a compared field in another form: regenerate the schemas, or drop that field from the tool's compare                                               |
| `/companion/token` or `/.well-known/jwks.json` is 404                             | `COMPANION_JWT_SIGNING_KEY` isn't set on that env                                                                                                                   |
| Sign-in fails on the ai-agent app                                                 | `eregister-ai-agent-1ms.pages.dev` isn't an authorized domain in Firebase                                                                                           |
| No launcher on the ai-agent app                                                   | `VITE_DILETTA_WIDGET_URL` or `VITE_DILETTA_API_BASE` is missing from `AI_AGENT_ENV` (build time: deploy again), or `diletta-widget.js` failed to load (network tab) |
| Launcher shows, panel says "Temporarily unavailable"                              | See `docs/runbooks/widget.md` › Troubleshooting. A 403 on `/widget/bootstrap` from a `<hash>.eregister-ai-agent-1ms.pages.dev` preview URL is expected              |
| `/companion/token` answers 403                                                    | The user isn't a member of the eRegister company open in the app                                                                                                    |
| Browser CORS error calling the eRegister API                                      | The app's origin isn't in the ai-agent env's `CORS_WHITELIST`                                                                                                       |

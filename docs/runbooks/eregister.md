# eRegister

eRegister is the first customer host (M7). This runbook covers its connection to Diletta (M7-1).

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

1. Create the company with `POST /operator/companies`. That's the only path that also creates its encryption key.
2. Create the connection:

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

In `evals/.env`:

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

## Check it works (M7-1 done when)

1. **Staging eval JWT works.** Run `pnpm evals:run --config <any config publicId of the company>`. The harness signs in to Firebase, then starts a run. Any answer past auth shows the eval JWT and the connection were accepted. Before M7-2 and M7-4 add tools and cases, that answer is likely a 400 `Invalid` (no active case). A 401 means the key (see `docs/runbooks/evals.md`), and a 403 means the connection isn't Staging or isn't Active.
2. **Production rejects it.** An eval JWT that names a production connection is 403 before anything is read (`authenticateEval`; `evalHarness.test.ts` "answers 401 without a valid platform signature, 403 for a production or unknown connection"). eRegister's production connection comes with M7-6. Repeat the check against it then.
3. **Companion JWT.** Signed in on `https://eregister-ai-agent-1ms.pages.dev`, `POST {iss}/api/p/companies/<id>/companion/token` answers a token whose header has `alg` ES256 and the `kid`, and whose claims have `iss` = the connection's issuer, `aud` `diletta-widget` and `exp - iat` = 300. The widget itself is embedded in M7-5.

## Troubleshooting

| Symptom                                                                           | Likely cause                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness: "eRegister test user sign-in failed: HTTP 400 INVALID_LOGIN_CREDENTIALS" | Wrong email or password, or Email/Password sign-in is off in Firebase                                                                             |
| Harness: "uid is not EVAL_HOST_USER"                                              | `EVAL_HOST_USER` holds the email or another user's uid                                                                                            |
| Widget: every connect refused as an unknown issuer                                | The connection's `jwt_issuer` and the token's `iss` differ (a trailing slash, the wrong env)                                                      |
| Widget: signature refused                                                         | `COMPANION_JWT_SIGNING_KEY` was rotated and the JWKS cache hasn't refetched yet (within a minute), or the JWKS route answers 404 (secret missing) |
| `/companion/token` or `/.well-known/jwks.json` is 404                             | `COMPANION_JWT_SIGNING_KEY` isn't set on that env                                                                                                 |
| Sign-in fails on the ai-agent app                                                 | `eregister-ai-agent-1ms.pages.dev` isn't an authorized domain in Firebase                                                                         |
| Browser CORS error calling the eRegister API                                      | The app's origin isn't in the ai-agent env's `CORS_WHITELIST`                                                                                     |

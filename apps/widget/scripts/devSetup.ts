import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import * as Schemas from "@app/schemas";
// DEV_NOTE: The backend's own publicId generator, so a dev connection's id is made like every other
import Utility from "../../backend/src/utils/Utility.ts";
import { readOwnerDatabaseUrl } from "../../backend/src/db/ownerDatabaseUrl.ts";
import { DEV_KEY_PATH, loadDevKey } from "./devJwt.ts";

// DEV_NOTE: Development only: makes the widget dev host able to sign in to the local backend (docs/runbooks/widget.md).
//   pnpm --filter widget dev:setup --company <companyPublicId>
// 1. Creates the local ES256 key and a dev issuer of its own (apps/widget/.dev/dev-key.json, gitignored), once.
// 2. Registers that issuer as an active staging company connection of the given company, with the dev host's origin
//    allowed, on the database in apps/backend/.env (the staging branch). It writes as the owner role (DATABASE_URL):
//    this is fixture setup, like a test's, never code under test.
// 3. Seeds the issuer's JWKS into the local backend's JWKS_CACHE (miniflare KV), since the dev issuer serves none.
// 4. Says what the company still lacks for a chat (a default chatbot, a published config, a model key).
const BACKEND_DIR = path.resolve(import.meta.dirname, "../../backend");

async function ensureDevKey(): Promise<Schemas.WidgetDevKey> {
  const existing = await loadDevKey();
  if (existing) return existing;

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const kid = `dev-${crypto.randomUUID()}`;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const devKey = Schemas.ZWidgetDevKey.parse({
    issuer: `https://widget-dev-${crypto.randomUUID()}.diletta.test`,
    kid,
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    publicJwk: { ...publicJwk, kid, alg: Schemas.WidgetJwtAlgorithmEnum.ES256, use: "sig" },
  });
  await mkdir(path.dirname(DEV_KEY_PATH), { recursive: true });
  await writeFile(DEV_KEY_PATH, JSON.stringify(devKey, null, 2), { mode: 0o600 });
  return devKey;
}

async function registerConnection(
  client: pg.Client,
  companyId: string,
  devKey: Schemas.WidgetDevKey,
) {
  const existing = await client.query<{ id: string }>(
    "SELECT id FROM company_connections WHERE jwt_issuer = $1",
    [devKey.issuer],
  );
  if (existing.rows[0]) {
    await client.query(
      `UPDATE company_connections
         SET company_id = $1, allowed_origins = $2, status = $3, updated_at = now()
       WHERE id = $4`,
      [
        companyId,
        [Schemas.WIDGET_DEV_ORIGIN],
        Schemas.CompanyConnectionStatusIntEnum.Active,
        existing.rows[0].id,
      ],
    );
    return;
  }
  await client.query(
    `INSERT INTO company_connections
       (public_id, company_id, environment, base_url, auth_type, auth_config, credential_scope, jwt_issuer,
        allowed_origins, status)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7, $8, $9)`,
    [
      Utility.generatePublicId(),
      companyId,
      Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
      Schemas.WIDGET_DEV_ORIGIN,
      Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      devKey.issuer,
      [Schemas.WIDGET_DEV_ORIGIN],
      Schemas.CompanyConnectionStatusIntEnum.Active,
    ],
  );
}

// DEV_NOTE: What a chat with this company needs that setup can't make: reported, not created
async function reportGaps(client: pg.Client, companyId: string): Promise<string[]> {
  const gaps: string[] = [];
  const chatbot = await client.query<{ id: string }>(
    "SELECT id FROM chatbots WHERE company_id = $1 AND is_default AND status = $2",
    [companyId, Schemas.ChatbotStatusIntEnum.Active],
  );
  const chatbotId = chatbot.rows[0]?.id;
  if (!chatbotId) {
    gaps.push("an active default chatbot");
  } else {
    const config = await client.query(
      "SELECT 1 FROM chatbot_configs WHERE chatbot_id = $1 AND status = $2",
      [chatbotId, Schemas.ChatbotConfigStatusIntEnum.Published],
    );
    if (config.rowCount === 0) gaps.push("a published config for the default chatbot");
  }
  const modelKey = await client.query(
    "SELECT 1 FROM company_secrets WHERE company_id = $1 AND type = $2 AND status = $3",
    [
      companyId,
      Schemas.CompanySecretTypeIntEnum.ModelKey,
      Schemas.CompanySecretStatusIntEnum.Active,
    ],
  );
  if (modelKey.rowCount === 0) gaps.push("an active model key");
  return gaps;
}

function seedLocalJwks(devKey: Schemas.WidgetDevKey) {
  const cached: Schemas.CachedJwks = {
    keys: [devKey.publicJwk],
    fetchedAt: Date.now(),
  };
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "kv",
      "key",
      "put",
      `jwks:${devKey.issuer}`,
      JSON.stringify(cached),
      "--binding",
      "JWKS_CACHE",
      "--local",
    ],
    { cwd: BACKEND_DIR, stdio: "inherit" },
  );
}

async function main() {
  const { values } = parseArgs({ options: { company: { type: "string" } } });
  if (!values.company) {
    throw new Error("Usage: pnpm --filter widget dev:setup --company <companyPublicId>");
  }

  const devKey = await ensureDevKey();
  const client = new pg.Client({ connectionString: readOwnerDatabaseUrl() });
  await client.connect();
  try {
    const company = await client.query<{ id: string }>(
      "SELECT id FROM companies WHERE public_id = $1",
      [values.company],
    );
    const companyId = company.rows[0]?.id;
    if (!companyId) throw new Error(`No company with publicId ${values.company}`);

    await registerConnection(client, companyId, devKey);
    seedLocalJwks(devKey);
    const gaps = await reportGaps(client, companyId);

    process.stdout.write(
      [
        `Dev issuer ${devKey.issuer} registered for company ${values.company}.`,
        `Run the backend (pnpm dev:backend) and the dev host (pnpm dev:widget), then open ${Schemas.WIDGET_DEV_ORIGIN}.`,
        gaps.length > 0
          ? `Before the chatbot can answer, the company still needs: ${gaps.join(", ")}.`
          : "The company has everything a chat needs.",
        "",
      ].join("\n"),
    );
  } finally {
    await client.end();
  }
}

await main();

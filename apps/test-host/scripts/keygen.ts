import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Makes the test host's secrets (docs/runbooks/test-host.md).
//   pnpm --filter test-host keygen                  writes apps/test-host/.dev.vars (local dev), once
//   pnpm --filter test-host keygen --signing-key    prints a new TEST_HOST_SIGNING_KEY, to pipe into
//                                                   `wrangler secret put TEST_HOST_SIGNING_KEY --env staging`
//   pnpm --filter test-host keygen --admin-secret   prints a new TEST_HOST_ADMIN_SECRET, the same way
// Nothing else is printed in the --signing-key / --admin-secret modes, so the pipe carries the value only.
const DEV_VARS_PATH = path.resolve(import.meta.dirname, "../.dev.vars");

async function createSigningKey(): Promise<Schemas.TestHostSigningKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  return Schemas.ZTestHostSigningKey.parse({
    kid: `test-host-${crypto.randomUUID()}`,
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  });
}

function createAdminSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "signing-key": { type: "boolean" },
      "admin-secret": { type: "boolean" },
    },
  });

  if (values["signing-key"]) {
    process.stdout.write(JSON.stringify(await createSigningKey()));
    return;
  }
  if (values["admin-secret"]) {
    process.stdout.write(createAdminSecret());
    return;
  }

  if (await exists(DEV_VARS_PATH)) {
    process.stdout.write(`${DEV_VARS_PATH} already exists; delete it to make new local secrets.\n`);
    return;
  }
  const lines = [
    `TEST_HOST_SIGNING_KEY='${JSON.stringify(await createSigningKey())}'`,
    `TEST_HOST_ADMIN_SECRET=${createAdminSecret()}`,
    "",
  ];
  await writeFile(DEV_VARS_PATH, lines.join("\n"), { mode: 0o600 });
  process.stdout.write(`Wrote ${DEV_VARS_PATH}.\n`);
}

await main();

# Master key

The platform master key encrypts each company's own encryption key (`company_encryption_keys.encrypted_key`). Company keys encrypt company data. Lose a master key and every company key it wrapped is unreadable, so every value is backed up outside Cloudflare.

## Where it lives

| Environment | Source                                                    | Secret name                        |
| ----------- | --------------------------------------------------------- | ---------------------------------- |
| Local       | `apps/backend/.dev.vars` → `MASTER_KEY_V1` (plain string) | value of the staging secret        |
| Staging     | Secrets Store binding `MASTER_KEY_V1` (`env.staging`)     | `diletta-master-key-v1-staging`    |
| Production  | Secrets Store binding `MASTER_KEY_V1` (`env.production`)  | `diletta-master-key-v1-production` |

- One Secrets Store per Cloudflare account: staging and production share it under different secret names. The store id is in `apps/backend/wrangler.jsonc`.
- Local dev and tests share the Neon staging database, so local **must** use the staging value. A different local key wraps company keys that deployed staging can't unwrap.
- Value format: base64 of 32 random bytes (AES-256-GCM). Code reads it only through `MasterKeyProvider.getMasterKey(env, version)` in `apps/backend/src/providers/masterKey.ts`, which returns a non-extractable `CryptoKey`.
- Secrets Store never returns a value once set. The password manager entries `diletta master key v1 (staging)` and `diletta master key v1 (production)` are the only copies outside Cloudflare.

## Local setup

1. Copy `apps/backend/.dev.vars.example` to `apps/backend/.dev.vars`.
2. Set `MASTER_KEY_V1` to the `diletta master key v1 (staging)` value from the password manager.
3. `pnpm --filter backend test` — `src/tests/masterKey.test.ts` fails if the key is missing or malformed.

Never put the production value on a dev machine.

## Create a secret

The API token needs **Account → Secrets Store → Edit** (and **User → Memberships → Read** for wrangler's secrets-store commands). The CI deploy token (`CLOUDFLARE_API_TOKEN` in the GitHub `staging` and `production` environments) needs **Secrets Store → Edit** too: Cloudflare treats binding a secret at deploy as a write, so deploys fail without it.

```bash
cd apps/backend
pnpm exec wrangler secrets-store store list --remote          # store id
umask 077 && openssl rand -base64 32 | tr -d '\n' > key.txt   # never echo it
pnpm exec wrangler secrets-store secret create <STORE_ID> \
  --name diletta-master-key-v1-staging --scopes workers --remote --value "$(cat key.txt)"
# save key.txt to the password manager, then:
rm key.txt
```

## Rotate to a new version

The master key is versioned, never overwritten: `company_encryption_keys.master_key_version` records which version wrapped each row, so old versions stay bound until no row uses them.

1. Create `diletta-master-key-v2-<env>` as above and back it up.
2. Add a `MASTER_KEY_V2` binding to `env.staging` and `env.production` in `wrangler.jsonc`, and `MASTER_KEY_V2` to `.dev.vars.example` (local gets the staging v2 value).
3. Run `pnpm --filter backend generate-types`, add `case 2` to `MasterKeyProvider.getSource`, and set `Constants.CURRENT_MASTER_KEY_VERSION = 2`.
4. Re-wrap every company key from v1 to v2: `EnvelopeCrypto.rewrapCompanyKey(v1, v2, encrypted_key, CryptoContext.companyKey(company_id, version))` (`packages/crypto`), then set `master_key_version = 2` on the row. The company key itself is unchanged, so no `encrypted_*` column is touched. The sweep job across companies is not built yet; build it on this function.
5. When no `company_encryption_keys` row has `master_key_version = 1`, remove the v1 binding, the `case 1`, and the v1 secret.

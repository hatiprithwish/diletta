import { env, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import {
  activityLog,
  chatbotConfigs,
  chatbots,
  chatbotUsers,
  companies,
  companyConnections,
  conversations,
} from "@/db/tables";
import worker from "@/index";
import JwksProvider from "@/providers/jwks";
import WidgetJwtProvider from "@/providers/widgetJwt";
import WidgetAuthRepo from "@/repositories/WidgetAuthRepo";
import Constants from "@/config/Constants";
import Utility from "@/utils/Utility";
import {
  base64Url,
  claimsFor,
  createKey,
  encodeJson,
  seedJwks,
  signToken,
} from "@/tests/helpers/widgetJwt";
// Declare env type for this test suite
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Mock logger to avoid logtape init overhead in tests
vi.mock("@/providers/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  configureLogger: vi.fn().mockResolvedValue(undefined),
  disposeLogger: vi.fn().mockResolvedValue(undefined),
  withRequestContext: vi.fn().mockImplementation((_id, next) => next()),
}));

// DEV_NOTE: Tests hit the Neon staging branch; the Repo runs as diletta_app (HYPERDRIVE), so RLS applies. Fixtures and
// cleanup run as the owner. Keys are generated per run, and each issuer's JWKS is seeded straight into the
// JWKS_CACHE KV (miniflare), so only the JWKS fetch tests reach fetch, through a spy.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";

const ORIGIN = "https://app.example.com";
const randomIssuer = () => `https://${crypto.randomUUID()}.example.com`;

const issuers = {
  active: randomIssuer(),
  disabled: randomIssuer(),
  paused: randomIssuer(),
  churned: randomIssuer(),
  noChatbot: randomIssuer(),
  fetchOk: randomIssuer(),
  fetchDown: randomIssuer(),
};

const BOOTSTRAP_CONFIG: Schemas.ConfigSpecV1Input = {
  persona: { instructions: "You help facility managers with their registers." },
  procedures: [],
  tools: [],
  approvalRules: [],
  routing: {
    small: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-haiku-4-5" },
    mid: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-sonnet-5-5" },
    top: { provider: Schemas.ModelProviderEnum.Anthropic, model: "claude-opus-5-5" },
    defaultTier: Schemas.ModelTierEnum.Mid,
  },
  knowledge: { sourceIds: [] },
  widget: {
    greeting: "Hi, what do you need?",
    suggestions: ["Which inspections are overdue?", "How do I add a custom field?"],
    launcherLabel: "Ask about your registers",
  },
};

const companyIds: string[] = [];
let companyA = "";
let defaultChatbotA: { publicId: string; name: string } = { publicId: "", name: "" };
let secondChatbotA = "";
let pausedChatbotA = "";
let chatbotOfB = "";

let rsaKey: Awaited<ReturnType<typeof createKey>>;
let ecKey: Awaited<ReturnType<typeof createKey>>;
let otherRsaKey: Awaited<ReturnType<typeof createKey>>; // same kid as rsaKey, different key pair: a forged signature
let weakRsaKey: Awaited<ReturnType<typeof createKey>>; // 1024-bit modulus

async function withOwnerDb(run: (ownerDb: NodePgDatabase) => Promise<void>) {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

// DEV_NOTE: Answers the JWKS URL of each listed issuer; any other fetch fails the test loudly
function mockJwksFetch(responses: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    for (const [issuer, respond] of Object.entries(responses)) {
      if (url === JwksProvider.getJwksUrl(issuer)) return respond();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const jwksResponse = (keys: Schemas.Jwk[]) =>
  new Response(JSON.stringify({ keys }), { headers: { "Content-Type": "application/json" } });

beforeAll(async () => {
  [rsaKey, ecKey, otherRsaKey, weakRsaKey] = await Promise.all([
    createKey(Schemas.WidgetJwtAlgorithmEnum.RS256, "rs-1"),
    createKey(Schemas.WidgetJwtAlgorithmEnum.ES256, "es-1"),
    createKey(Schemas.WidgetJwtAlgorithmEnum.RS256, "rs-1"),
    createKey(Schemas.WidgetJwtAlgorithmEnum.RS256, "rs-weak", 1024),
  ]);

  await withOwnerDb(async (ownerDb) => {
    const created = await ownerDb
      .insert(companies)
      .values([
        { publicId: Utility.generatePublicId(), name: `Widget A ${crypto.randomUUID()}` },
        { publicId: Utility.generatePublicId(), name: `Widget B ${crypto.randomUUID()}` },
        {
          publicId: Utility.generatePublicId(),
          name: `Widget paused ${crypto.randomUUID()}`,
          status: Schemas.CompanyStatusIntEnum.Paused,
        },
        {
          publicId: Utility.generatePublicId(),
          name: `Widget churned ${crypto.randomUUID()}`,
          status: Schemas.CompanyStatusIntEnum.Churned,
        },
        { publicId: Utility.generatePublicId(), name: `Widget no bot ${crypto.randomUUID()}` },
      ])
      .returning({ id: companies.id });
    const [a, b, paused, churned, noChatbot] = created.map((row) => row.id) as [
      string,
      string,
      string,
      string,
      string,
    ];
    companyA = a;
    companyIds.push(a, b, paused, churned, noChatbot);

    const bots = await ownerDb
      .insert(chatbots)
      .values([
        { publicId: Utility.generatePublicId(), companyId: a, name: "A default", isDefault: true },
        { publicId: Utility.generatePublicId(), companyId: a, name: "A second" },
        {
          publicId: Utility.generatePublicId(),
          companyId: a,
          name: "A paused",
          status: Schemas.ChatbotStatusIntEnum.Paused,
        },
        { publicId: Utility.generatePublicId(), companyId: b, name: "B default", isDefault: true },
        { publicId: Utility.generatePublicId(), companyId: paused, name: "P", isDefault: true },
        { publicId: Utility.generatePublicId(), companyId: churned, name: "C", isDefault: true },
      ])
      .returning({ id: chatbots.id, publicId: chatbots.publicId, name: chatbots.name });
    defaultChatbotA = { publicId: bots[0]!.publicId, name: bots[0]!.name };
    secondChatbotA = bots[1]!.publicId;
    pausedChatbotA = bots[2]!.publicId;
    chatbotOfB = bots[3]!.publicId;

    // DEV_NOTE: A published config for A's default chatbot only (the bootstrap reads its widget settings); A's second
    // chatbot has none
    const normalized = Schemas.normalizeConfigBody(BOOTSTRAP_CONFIG);
    if (!normalized.body || !normalized.schemaVersion) throw new Error("Config body invalid");
    await ownerDb.insert(chatbotConfigs).values({
      publicId: Utility.generatePublicId(),
      companyId: a,
      chatbotId: bots[0]!.id,
      configVersion: 1,
      schemaVersion: normalized.schemaVersion,
      status: Schemas.ChatbotConfigStatusIntEnum.Published,
      body: normalized.body,
      bodyHash: "test-bootstrap",
      publishedAt: new Date(),
    });

    const connection = (
      companyId: string,
      jwtIssuer: string,
      status = Schemas.CompanyConnectionStatusIntEnum.Active,
    ) => ({
      publicId: Utility.generatePublicId(),
      companyId,
      environment: Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
      baseUrl: "https://host.example.com/api",
      authType: Schemas.CompanyConnectionAuthTypeEnum.JwtForward,
      authConfig: {},
      credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum.None,
      jwtIssuer,
      allowedOrigins: [ORIGIN],
      status,
    });
    await ownerDb
      .insert(companyConnections)
      .values([
        connection(a, issuers.active),
        connection(a, issuers.disabled, Schemas.CompanyConnectionStatusIntEnum.Disabled),
        connection(paused, issuers.paused),
        connection(churned, issuers.churned),
        connection(noChatbot, issuers.noChatbot),
        connection(a, issuers.fetchOk),
        connection(a, issuers.fetchDown),
      ]);
  });
});

afterAll(async () => {
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb
      .delete(companyConnections)
      .where(inArray(companyConnections.companyId, companyIds));
    await ownerDb.delete(chatbotConfigs).where(inArray(chatbotConfigs.companyId, companyIds));
    await ownerDb.delete(chatbots).where(inArray(chatbots.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

beforeEach(async () => {
  const keys = [rsaKey.jwk, ecKey.jwk, weakRsaKey.jwk];
  await Promise.all(
    [issuers.active, issuers.disabled, issuers.paused, issuers.churned, issuers.noChatbot].map(
      (issuer) => seedJwks(issuer, keys),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WidgetJwtProvider.decode", () => {
  it("decodes a well-formed token without trusting it", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active));
    const result = WidgetJwtProvider.decode(token);
    expect(result.isSuccess).toBe(true);
    expect(result.jwt?.header).toMatchObject({ alg: "RS256", kid: "rs-1" });
    expect(result.jwt?.claims.iss).toBe(issuers.active);
  });

  it("rejects alg none and HS256", async () => {
    const claims = encodeJson(claimsFor(issuers.active));
    const none = `${encodeJson({ alg: "none", kid: "rs-1" })}.${claims}.`;
    const hs256 = `${encodeJson({ alg: "HS256", kid: "rs-1" })}.${claims}.${base64Url(new Uint8Array(32))}`;
    expect(WidgetJwtProvider.decode(none).isSuccess).toBe(false);
    expect(WidgetJwtProvider.decode(hs256).isSuccess).toBe(false);
  });

  it("rejects a token without kid", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active), { kid: undefined });
    expect(WidgetJwtProvider.decode(token).isSuccess).toBe(false);
  });

  it("rejects a token without sub or iat", async () => {
    const noSub = await signToken(rsaKey, claimsFor(issuers.active, { sub: undefined }));
    const noIat = await signToken(rsaKey, claimsFor(issuers.active, { iat: undefined }));
    expect(WidgetJwtProvider.decode(noSub).isSuccess).toBe(false);
    expect(WidgetJwtProvider.decode(noIat).isSuccess).toBe(false);
  });

  it("rejects a token with a crit header", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active), { crit: ["exp"] });
    expect(WidgetJwtProvider.decode(token).isSuccess).toBe(false);
  });

  it("keeps sub exactly as signed and rejects a blank one", async () => {
    const padded = await signToken(rsaKey, claimsFor(issuers.active, { sub: " alice " }));
    const blank = await signToken(rsaKey, claimsFor(issuers.active, { sub: "   " }));
    expect(WidgetJwtProvider.decode(padded).jwt?.claims.sub).toBe(" alice ");
    expect(WidgetJwtProvider.decode(blank).isSuccess).toBe(false);
  });

  it("rejects malformed and oversized tokens", () => {
    expect(WidgetJwtProvider.decode("not-a-jwt").isSuccess).toBe(false);
    expect(WidgetJwtProvider.decode("a.b.c").isSuccess).toBe(false);
    expect(
      WidgetJwtProvider.decode("x".repeat(Constants.WIDGET_JWT_MAX_LENGTH + 1)).isSuccess,
    ).toBe(false);
  });
});

describe("WidgetJwtProvider.checkClaims", () => {
  const now = 1_800_000_000;
  const claims = (overrides: Partial<Schemas.WidgetJwtClaims> = {}): Schemas.WidgetJwtClaims => ({
    iss: issuers.active,
    sub: "host-user-1",
    aud: Schemas.WIDGET_JWT_AUDIENCE,
    iat: now,
    exp: now + 300,
    ...overrides,
  });

  it("accepts a valid token, with aud as a string or an array", () => {
    expect(WidgetJwtProvider.checkClaims(claims(), now).isSuccess).toBe(true);
    expect(
      WidgetJwtProvider.checkClaims(claims({ aud: ["other", Schemas.WIDGET_JWT_AUDIENCE] }), now)
        .isSuccess,
    ).toBe(true);
  });

  it("rejects the wrong audience", () => {
    const result = WidgetJwtProvider.checkClaims(claims({ aud: "another-service" }), now);
    expect(result.isSuccess).toBe(false);
    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
  });

  it("rejects an expired token, allowing the clock skew", () => {
    const skew = Constants.WIDGET_JWT_CLOCK_SKEW_SECONDS;
    const expiring = claims({ iat: now - 200, exp: now - 10 });
    expect(WidgetJwtProvider.checkClaims(expiring, now).isSuccess).toBe(true);
    expect(WidgetJwtProvider.checkClaims(expiring, now - 10 + skew).isSuccess).toBe(false);
  });

  it("rejects a token issued in the future", () => {
    const skew = Constants.WIDGET_JWT_CLOCK_SKEW_SECONDS;
    const result = WidgetJwtProvider.checkClaims(
      claims({ iat: now + skew + 1, exp: now + skew + 60 }),
      now,
    );
    expect(result.isSuccess).toBe(false);
  });

  it("honours nbf, allowing the clock skew", () => {
    const skew = Constants.WIDGET_JWT_CLOCK_SKEW_SECONDS;
    expect(WidgetJwtProvider.checkClaims(claims({ nbf: now - 10 }), now).isSuccess).toBe(true);
    expect(WidgetJwtProvider.checkClaims(claims({ nbf: now + skew }), now).isSuccess).toBe(true);
    expect(WidgetJwtProvider.checkClaims(claims({ nbf: now + skew + 1 }), now).isSuccess).toBe(
      false,
    );
  });

  it("rejects a lifetime over 5 minutes, or exp not after iat", () => {
    expect(WidgetJwtProvider.checkClaims(claims({ exp: now + 301 }), now).isSuccess).toBe(false);
    expect(WidgetJwtProvider.checkClaims(claims({ exp: now }), now).isSuccess).toBe(false);
  });
});

describe("JwksProvider", () => {
  it("builds the JWKS URL from the issuer", () => {
    expect(JwksProvider.getJwksUrl("https://auth.example.com/")).toBe(
      "https://auth.example.com/.well-known/jwks.json",
    );
    expect(JwksProvider.getJwksUrl("https://auth.example.com/tenant")).toBe(
      "https://auth.example.com/tenant/.well-known/jwks.json",
    );
  });

  it("fetches an uncached JWKS once, then serves it from KV", async () => {
    const issuer = randomIssuer();
    const fetchSpy = mockJwksFetch({ [issuer]: () => jwksResponse([rsaKey.jwk]) });

    const first = await JwksProvider.getJwks(env, issuer);
    const second = await JwksProvider.getJwks(env, issuer);

    expect(first.isSuccess).toBe(true);
    expect(second.jwks?.keys[0]?.kid).toBe("rs-1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails when the issuer's JWKS endpoint errors or returns no key set", async () => {
    const down = randomIssuer();
    const garbage = randomIssuer();
    mockJwksFetch({
      [down]: () => new Response("unavailable", { status: 503 }),
      [garbage]: () => new Response(JSON.stringify({ nope: true })),
    });

    expect((await JwksProvider.getJwks(env, down)).isSuccess).toBe(false);
    expect((await JwksProvider.getJwks(env, garbage)).isSuccess).toBe(false);
  });

  it("refuses a JWKS over the size cap, declared or streamed", async () => {
    const declared = randomIssuer();
    const streamed = randomIssuer();
    // DEV_NOTE: No Content-Length and no end: the body streams 16 KB chunks forever, so only a reader that counts
    // bytes and cancels past the cap returns at all
    let isCancelled = false;
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    mockJwksFetch({
      [declared]: () =>
        new Response(JSON.stringify({ keys: [] }), {
          headers: { "Content-Length": String(Constants.JWKS_MAX_BYTES + 1) },
        }),
      [streamed]: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              isCancelled = true;
            },
          }),
        ),
    });

    const declaredResult = await JwksProvider.getJwks(env, declared);
    const streamedResult = await JwksProvider.getJwks(env, streamed);
    expect(declaredResult.isSuccess).toBe(false);
    expect(declaredResult.message).toBe("Issuer JWKS is too large");
    expect(streamedResult.isSuccess).toBe(false);
    expect(streamedResult.message).toBe("Issuer JWKS is too large");
    expect(isCancelled).toBe(true);
  });

  it("skips a refetch within the minimum interval and refetches after it", async () => {
    const fresh = randomIssuer();
    const stale = randomIssuer();
    await seedJwks(fresh, [rsaKey.jwk]);
    await seedJwks(stale, [rsaKey.jwk], Date.now() - Constants.JWKS_REFETCH_MIN_INTERVAL_MS - 1);
    const fetchSpy = mockJwksFetch({ [stale]: () => jwksResponse([rsaKey.jwk, ecKey.jwk]) });

    const skipped = await JwksProvider.refreshJwks(env, fresh);
    const refetched = await JwksProvider.refreshJwks(env, stale);

    expect(skipped.jwks?.keys).toHaveLength(1);
    expect(refetched.jwks?.keys).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("company connection jwtIssuer", () => {
  it("rejects an issuer with a query or fragment", () => {
    const issuer = Schemas.ZCompanyConnectionBase.shape.jwtIssuer;
    expect(issuer.safeParse("https://auth.example.com/tenant").success).toBe(true);
    expect(issuer.safeParse("https://auth.example.com/?tenant=a").success).toBe(false);
    expect(issuer.safeParse("https://auth.example.com/#a").success).toBe(false);
  });
});

describe("WidgetAuthRepo.authenticate", () => {
  const authenticate = (
    token: string,
    options: { origin?: string | null; chatbotPublicId?: string | null } = {},
  ) =>
    new WidgetAuthRepo(env).authenticate({
      token,
      origin: options.origin === undefined ? ORIGIN : options.origin,
      chatbotPublicId: options.chatbotPublicId ?? null,
    });

  it("accepts an RS256 token and resolves the default chatbot", async () => {
    const result = await authenticate(await signToken(rsaKey, claimsFor(issuers.active)));

    expect(result.isSuccess).toBe(true);
    expect(result.identity).toMatchObject({
      companyId: companyA,
      chatbotPublicId: defaultChatbotA.publicId,
      chatbotName: defaultChatbotA.name,
      hostUserId: "host-user-1",
      displayName: "Ada",
      roles: ["editor"],
    });
  });

  it("accepts an ES256 token and resolves the chatbot the embed names", async () => {
    const result = await authenticate(await signToken(ecKey, claimsFor(issuers.active)), {
      chatbotPublicId: secondChatbotA,
    });

    expect(result.isSuccess).toBe(true);
    expect(result.identity?.chatbotPublicId).toBe(secondChatbotA);
  });

  it("rejects a bad signature", async () => {
    // DEV_NOTE: Signed by another key under the issuer's kid, and a valid token whose claims were swapped afterwards
    const forged = await signToken(otherRsaKey, claimsFor(issuers.active));
    const [header, , signature] = (await signToken(ecKey, claimsFor(issuers.active))).split(".");
    const tampered = `${header}.${encodeJson(claimsFor(issuers.active, { sub: "someone-else" }))}.${signature}`;

    expect((await authenticate(forged)).failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
    expect((await authenticate(tampered)).failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      rsaKey,
      claimsFor(issuers.active, { iat: now - 400, exp: now - 120 }),
    );

    const result = await authenticate(token);
    expect(result.isSuccess).toBe(false);
    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
  });

  it("rejects a wrong-audience token", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active, { aud: "another-service" }));

    const result = await authenticate(token);
    expect(result.isSuccess).toBe(false);
    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
  });

  it("rejects an alg none token", async () => {
    const token = `${encodeJson({ alg: "none", kid: "rs-1" })}.${encodeJson(claimsFor(issuers.active))}.`;
    expect((await authenticate(token)).failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
  });

  it("rejects a key published for another algorithm under the token's kid", async () => {
    const token = await signToken(ecKey, claimsFor(issuers.active), { alg: "RS256" });
    expect((await authenticate(token)).failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
  });

  it("rejects an RSA key under 2048 bits", async () => {
    const token = await signToken(weakRsaKey, claimsFor(issuers.active));
    expect((await authenticate(token)).failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
  });

  it("refetches the JWKS once for an unknown kid, then rejects", async () => {
    const unknown = await createKey(Schemas.WidgetJwtAlgorithmEnum.RS256, "rs-unknown");
    await seedJwks(
      issuers.active,
      [rsaKey.jwk],
      Date.now() - Constants.JWKS_REFETCH_MIN_INTERVAL_MS - 1,
    );
    const fetchSpy = mockJwksFetch({ [issuers.active]: () => jwksResponse([rsaKey.jwk]) });

    const result = await authenticate(await signToken(unknown, claimsFor(issuers.active)));

    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts a key the host rotated in, found by the refetch", async () => {
    const rotated = await createKey(Schemas.WidgetJwtAlgorithmEnum.ES256, "es-rotated");
    await seedJwks(
      issuers.active,
      [rsaKey.jwk],
      Date.now() - Constants.JWKS_REFETCH_MIN_INTERVAL_MS - 1,
    );
    mockJwksFetch({ [issuers.active]: () => jwksResponse([rsaKey.jwk, rotated.jwk]) });

    const result = await authenticate(await signToken(rotated, claimsFor(issuers.active)));
    expect(result.isSuccess).toBe(true);
  });

  it("rejects an unregistered issuer without fetching its JWKS", async () => {
    const fetchSpy = mockJwksFetch({});
    const result = await authenticate(await signToken(rsaKey, claimsFor(randomIssuer())));

    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches and caches an uncached issuer's JWKS", async () => {
    const fetchSpy = mockJwksFetch({ [issuers.fetchOk]: () => jwksResponse([rsaKey.jwk]) });

    const first = await authenticate(await signToken(rsaKey, claimsFor(issuers.fetchOk)));
    const second = await authenticate(await signToken(rsaKey, claimsFor(issuers.fetchOk)));

    expect(first.isSuccess).toBe(true);
    expect(second.isSuccess).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails as a server error when the issuer's JWKS can't be read", async () => {
    mockJwksFetch({ [issuers.fetchDown]: () => new Response("down", { status: 500 }) });
    const result = await authenticate(await signToken(rsaKey, claimsFor(issuers.fetchDown)));
    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.ServerError);
  });

  it("answers Unauthorized to an unsigned probe, whatever the issuer, connection or origin", async () => {
    // DEV_NOTE: A forged token must not tell a registered issuer, a disabled connection or an allowed origin apart
    const probe = (issuer: string) => signToken(otherRsaKey, claimsFor(issuer));
    const results = await Promise.all([
      authenticate(await probe(randomIssuer())),
      authenticate(await probe(issuers.active)),
      authenticate(await probe(issuers.disabled)),
      authenticate(await probe(issuers.active), { origin: "https://evil.example.com" }),
      authenticate(await probe(issuers.paused)),
    ]);
    for (const result of results) {
      expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Unauthorized);
    }
  });

  it("rejects a disabled connection", async () => {
    const result = await authenticate(await signToken(rsaKey, claimsFor(issuers.disabled)));
    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Forbidden);
  });

  it("rejects an origin the connection doesn't allow, or none", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active));
    expect((await authenticate(token, { origin: "https://evil.example.com" })).failure).toBe(
      Schemas.WidgetAuthFailureEnum.Forbidden,
    );
    expect((await authenticate(token, { origin: `${ORIGIN}/` })).failure).toBe(
      Schemas.WidgetAuthFailureEnum.Forbidden,
    );
    expect((await authenticate(token, { origin: null })).failure).toBe(
      Schemas.WidgetAuthFailureEnum.Forbidden,
    );
  });

  it("rejects paused and churned companies", async () => {
    const paused = await authenticate(await signToken(rsaKey, claimsFor(issuers.paused)));
    const churned = await authenticate(await signToken(rsaKey, claimsFor(issuers.churned)));
    expect(paused.failure).toBe(Schemas.WidgetAuthFailureEnum.Forbidden);
    expect(churned.failure).toBe(Schemas.WidgetAuthFailureEnum.Forbidden);
  });

  it("rejects a paused chatbot", async () => {
    const result = await authenticate(await signToken(rsaKey, claimsFor(issuers.active)), {
      chatbotPublicId: pausedChatbotA,
    });
    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.Forbidden);
  });

  it("can't reach another company's chatbot", async () => {
    const result = await authenticate(await signToken(rsaKey, claimsFor(issuers.active)), {
      chatbotPublicId: chatbotOfB,
    });
    expect(result.isSuccess).toBe(false);
    expect(result.failure).toBe(Schemas.WidgetAuthFailureEnum.NotFound);
    expect(result.identity).toBeUndefined();
  });

  it("answers not found for an unknown chatbot or a company with no default", async () => {
    const unknown = await authenticate(await signToken(rsaKey, claimsFor(issuers.active)), {
      chatbotPublicId: Utility.generatePublicId(),
    });
    const noDefault = await authenticate(await signToken(rsaKey, claimsFor(issuers.noChatbot)));
    expect(unknown.failure).toBe(Schemas.WidgetAuthFailureEnum.NotFound);
    expect(noDefault.failure).toBe(Schemas.WidgetAuthFailureEnum.NotFound);
  });
});

// DEV_NOTE: Failures only: every check runs before the upgrade, so a rejected widget gets an HTTP status and never a
// socket. The accepted path (a socket into the Conversation DO) is covered in conversation.test.ts.
describe("GET /widget/ws", () => {
  async function upgrade(
    options: { query?: string; origin?: string | null; protocols?: string[] | null } = {},
  ) {
    const headers: Record<string, string> = { Upgrade: "websocket" };
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers["Origin"] = origin;
    if (options.protocols !== null) {
      const protocols = options.protocols ?? [
        Schemas.WIDGET_SUBPROTOCOL,
        await signToken(rsaKey, claimsFor(issuers.active)),
      ];
      headers["Sec-WebSocket-Protocol"] = protocols.join(", ");
    }
    return await worker.fetch(
      new Request(`http://localhost/widget/ws${options.query ?? ""}`, { headers }),
      env,
      createExecutionContext(),
    );
  }

  it("answers 426 without a WebSocket upgrade", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/widget/ws"),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(426);
  });

  it("answers 401 without the token in the subprotocol, or without diletta.v1", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active));
    for (const protocols of [null, [Schemas.WIDGET_SUBPROTOCOL], [token]]) {
      const response = await upgrade({ protocols });
      expect(response.status).toBe(401);
      expect(response.webSocket).toBeNull();
    }
  });

  it("checks the token before the query: 401 without one, 400 only for a verified token", async () => {
    const badQuery = `?conversation=${"x".repeat(65)}`;
    expect((await upgrade({ query: badQuery, protocols: null })).status).toBe(401);
    expect(
      (await upgrade({ query: badQuery, protocols: [Schemas.WIDGET_SUBPROTOCOL, "not-a-jwt"] }))
        .status,
    ).toBe(401);
    expect((await upgrade({ query: badQuery })).status).toBe(400);
  });

  it("ignores a token in the URL", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active));
    const response = await upgrade({
      query: `?token=${token}`,
      protocols: [Schemas.WIDGET_SUBPROTOCOL],
    });
    expect(response.status).toBe(401);
  });

  it("answers 401 on a bad token, with a generic body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signToken(
      rsaKey,
      claimsFor(issuers.active, { iat: now - 400, exp: now - 120 }),
    );
    const response = await upgrade({ protocols: [Schemas.WIDGET_SUBPROTOCOL, expired] });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ isSuccess: false, message: "Unauthorized" });
  });

  it("answers 403 on an origin the connection doesn't allow", async () => {
    const response = await upgrade({ origin: "https://evil.example.com" });
    expect(response.status).toBe(403);
  });

  it("answers 404 on a chatbot of another company", async () => {
    const response = await upgrade({ query: `?chatbot=${chatbotOfB}` });
    expect(response.status).toBe(404);
  });
});

// DEV_NOTE: The widget's bootstrap read (M2-7, ADR 0002): the same token checks as the socket, the token in
// Authorization: Bearer, CORS for any origin without credentials, and nothing created
describe("GET /widget/bootstrap", () => {
  async function bootstrap(
    options: {
      query?: string;
      origin?: string | null;
      authorization?: string | null;
      method?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    const origin = options.origin === undefined ? ORIGIN : options.origin;
    if (origin !== null) headers["Origin"] = origin;
    if (options.authorization !== null) {
      headers["Authorization"] =
        options.authorization ?? `Bearer ${await signToken(rsaKey, claimsFor(issuers.active))}`;
    }
    return await worker.fetch(
      new Request(`http://localhost/widget/bootstrap${options.query ?? ""}`, {
        method: options.method ?? "GET",
        headers,
      }),
      env,
      createExecutionContext(),
    );
  }

  it("answers the default chatbot's name and widget settings, readable cross-origin", async () => {
    const response = await bootstrap();
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const body = Schemas.ZWidgetBootstrapApiResponse.parse(await response.json());
    expect(body.bootstrap).toEqual({
      chatbot: defaultChatbotA,
      widget: {
        greeting: "Hi, what do you need?",
        suggestions: ["Which inspections are overdue?", "How do I add a custom field?"],
        launcherLabel: "Ask about your registers",
      },
    });
  });

  it("answers widget null for a chatbot with no published config", async () => {
    const response = await bootstrap({ query: `?chatbot=${secondChatbotA}` });
    expect(response.status).toBe(200);
    const body = Schemas.ZWidgetBootstrapApiResponse.parse(await response.json());
    expect(body.bootstrap?.chatbot.publicId).toBe(secondChatbotA);
    expect(body.bootstrap?.widget).toBeNull();
  });

  it("answers a preflight for any origin, allowing only the Authorization header", async () => {
    const response = await bootstrap({
      method: "OPTIONS",
      authorization: null,
      origin: "https://host.example.org",
      headers: {
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://host.example.org");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Authorization");
  });

  it("answers 401 without a bearer token, or with a bad one, with a generic body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await signToken(
      rsaKey,
      claimsFor(issuers.active, { iat: now - 400, exp: now - 120 }),
    );
    for (const authorization of [null, "Basic abc", `Bearer ${expired}`]) {
      const response = await bootstrap({ authorization });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ isSuccess: false, message: "Unauthorized" });
    }
  });

  it("ignores a token in the URL", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active));
    const response = await bootstrap({ query: `?token=${token}`, authorization: null });
    expect(response.status).toBe(401);
  });

  it("answers 403 on an origin the connection doesn't allow, 404 on another company's chatbot", async () => {
    expect((await bootstrap({ origin: "https://evil.example.com" })).status).toBe(403);
    expect((await bootstrap({ origin: null })).status).toBe(403);
    expect((await bootstrap({ query: `?chatbot=${chatbotOfB}` })).status).toBe(404);
    expect((await bootstrap({ query: `?chatbot=${pausedChatbotA}` })).status).toBe(403);
  });

  it("creates nothing: no chatbot user, conversation or activity row", async () => {
    const counts = async () => {
      let found = { chatbotUsers: -1, conversations: -1, activity: -1 };
      await withOwnerDb(async (ownerDb) => {
        found = {
          chatbotUsers: await ownerDb.$count(chatbotUsers, eq(chatbotUsers.companyId, companyA)),
          conversations: await ownerDb.$count(conversations, eq(conversations.companyId, companyA)),
          activity: await ownerDb.$count(activityLog, eq(activityLog.companyId, companyA)),
        };
      });
      return found;
    };
    const before = await counts();
    expect((await bootstrap()).status).toBe(200);
    expect((await bootstrap({ query: `?chatbot=${secondChatbotA}` })).status).toBe(200);
    expect(await counts()).toEqual(before);
  });

  it("checks the token before the query: 401 without one, 400 only for a verified token", async () => {
    const badQuery = `?chatbot=${"x".repeat(65)}`;
    expect((await bootstrap({ query: badQuery, authorization: null })).status).toBe(401);
    expect((await bootstrap({ query: badQuery, authorization: "Bearer not-a-jwt" })).status).toBe(
      401,
    );
    expect((await bootstrap({ query: badQuery })).status).toBe(400);
  });

  it("accepts the bearer scheme in any case", async () => {
    const token = await signToken(rsaKey, claimsFor(issuers.active));
    expect((await bootstrap({ authorization: `bearer ${token}` })).status).toBe(200);
  });
});

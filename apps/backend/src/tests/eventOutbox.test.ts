import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as Schemas from "@app/schemas";
import Constants from "@/config/Constants";
import runOutboxSweep from "@/crons/OutboxSweepCron";
import getDbClient from "@/db/dbClient";
import { activityLog, companies, eventOutbox } from "@/db/tables";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import CriticalEventProvider from "@/providers/criticalEvent";
import AppLogger from "@/providers/logger";
import consumeEvents from "@/queues/EventsConsumer";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import Utility from "@/utils/Utility";
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

// DEV_NOTE: Tests hit the Neon staging branch. Two companies inserted as owner fixtures (the outbox needs no company
// key). The Repo and provider run as diletta_app (HYPERDRIVE), so RLS applies; the owner connection only inserts
// fixtures, backdates rows (the sweep only picks rows older than a minute) and cleans up. EVENTS_QUEUE is replaced
// by a recording fake, so the tests can see exactly what each relay sent and make sends fail. The sweep and purge
// are cross-company by design, so on the shared staging branch they also act on other companies' stale rows, as the
// staging Cron does.
const ownerDatabaseUrl =
  "DATABASE_URL" in env && typeof env.DATABASE_URL === "string" ? env.DATABASE_URL : "";
const createdCompanyIds: string[] = [];
let companyA = "";
let companyB = "";

type Sent = Schemas.EventOutboxMessage;

// DEV_NOTE: Records every sendBatch; failWith makes it throw, hold makes it wait until released (to keep a relay's
// row locks open while another relay runs)
class FakeQueue implements Queue<Schemas.EventOutboxMessage> {
  sent: Sent[] = [];
  failWith: Error | null = null;
  private hold: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private entered: (() => void) | null = null;

  holdNextSend(): { entered: Promise<void>; release: () => void } {
    const entered = new Promise<void>((resolve) => (this.entered = resolve));
    this.hold = new Promise<void>((resolve) => (this.release = resolve));
    return { entered, release: () => this.release?.() };
  }

  async metrics(): Promise<QueueMetrics> {
    return { backlogCount: 0, backlogBytes: 0 };
  }

  async send(message: Sent): Promise<QueueSendResponse> {
    await this.sendBatch([{ body: message }]);
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  }

  async sendBatch(messages: Iterable<MessageSendRequest<Sent>>): Promise<QueueSendBatchResponse> {
    const bodies = [...messages].map((message) => message.body);
    if (this.hold) {
      const hold = this.hold;
      this.hold = null;
      this.entered?.();
      await hold;
    }
    if (this.failWith) throw this.failWith;
    this.sent.push(...bodies);
    return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
  }

  sentFor(outboxId: string): Sent[] {
    return this.sent.filter((message) => message.outboxId === outboxId);
  }
}

let queue: FakeQueue;
const repoEnv = (): Env => ({ ...env, EVENTS_QUEUE: queue });

async function withOwnerDb<T>(run: (ownerDb: NodePgDatabase) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    return await run(drizzle({ client: pool }));
  } finally {
    await pool.end();
  }
}

async function createCompany(ownerDb: NodePgDatabase): Promise<string> {
  const [row] = await ownerDb
    .insert(companies)
    .values({ publicId: Utility.generatePublicId(), name: `Test company ${crypto.randomUUID()}` })
    .returning({ id: companies.id });
  const companyId = row?.id ?? "";
  createdCompanyIds.push(companyId);
  return companyId;
}

// DEV_NOTE: A random bigint-shaped id for the polymorphic entityId, so each test can count its own log rows
const randomEntityId = () => String(Math.floor(Math.random() * 1_000_000_000) + 1);

const criticalEvent = (
  companyId: string,
  overrides: Partial<Schemas.CriticalEventBase> = {},
): Schemas.CriticalEventBase & { companyId: string } => ({
  companyId,
  actorType: Schemas.ActivityLogActorTypeIntEnum.System,
  actorId: null,
  entityType: "change_request",
  entityId: randomEntityId(),
  entityAction: "verified",
  entityVersion: null,
  parentLogId: null,
  rootLogId: null,
  detail: { reason: "test" },
  eventType: "change_request.verified",
  dedupeKey: `test:${crypto.randomUUID()}`,
  ...overrides,
});

async function getOutboxRow(outboxId: string) {
  return await withOwnerDb(async (ownerDb) => {
    const [row] = await ownerDb.select().from(eventOutbox).where(eq(eventOutbox.id, outboxId));
    return row;
  });
}

async function backdateOutboxRow(outboxId: string, msAgo: number) {
  await withOwnerDb(async (ownerDb) => {
    await ownerDb
      .update(eventOutbox)
      .set({ createdAt: new Date(Date.now() - msAgo) })
      .where(eq(eventOutbox.id, outboxId));
  });
}

beforeAll(async () => {
  await withOwnerDb(async (ownerDb) => {
    companyA = await createCompany(ownerDb);
    companyB = await createCompany(ownerDb);
  });
});

beforeEach(() => {
  queue = new FakeQueue();
  vi.mocked(AppLogger.error).mockClear();
  vi.mocked(AppLogger.info).mockClear();
});

afterAll(async () => {
  const companyIds = createdCompanyIds.filter(Boolean);
  if (companyIds.length === 0) return;
  await withOwnerDb(async (ownerDb) => {
    await ownerDb.delete(eventOutbox).where(inArray(eventOutbox.companyId, companyIds));
    await ownerDb.delete(activityLog).where(inArray(activityLog.companyId, companyIds));
    await ownerDb.delete(companies).where(inArray(companies.id, companyIds));
  });
});

describe("CriticalEventProvider", () => {
  it("writes the activity_log row and its pending event_outbox row together", async () => {
    const event = criticalEvent(companyA);
    const recorded = await new EventOutboxRepo(repoEnv()).recordCriticalEvent(event);
    expect(recorded.isSuccess).toBe(true);
    expect(recorded.wasDuplicate).toBe(false);

    const outbox = await getOutboxRow(recorded.outboxId ?? "");
    expect(outbox?.activityLogId).toBe(recorded.activityLogId);
    expect(outbox?.status).toBe(Schemas.EventOutboxStatusIntEnum.Pending);
    expect(outbox?.attempts).toBe(0);
    expect(outbox?.eventType).toBe(event.eventType);

    const [log] = await withOwnerDb((ownerDb) =>
      ownerDb
        .select()
        .from(activityLog)
        .where(eq(activityLog.id, recorded.activityLogId ?? "")),
    );
    expect(log?.companyId).toBe(companyA);
    expect(log?.entityId).toBe(event.entityId);
    expect(log?.detail).toEqual({ reason: "test" });
  });

  it("leaves neither row when the caller's transaction rolls back", async () => {
    const event = criticalEvent(companyA);
    let recorded: Schemas.RecordCriticalEventResponse = { isSuccess: false };

    const result = await withTenant(getDbClient(env), companyA, async (tx) => {
      recorded = await CriticalEventProvider.record(tx, event);
      throw new TenantRollbackError("Caller's change failed");
    });
    expect(result.isSuccess).toBe(false);
    expect(recorded.isSuccess).toBe(true);

    await withOwnerDb(async (ownerDb) => {
      const outboxRows = await ownerDb
        .select({ id: eventOutbox.id })
        .from(eventOutbox)
        .where(eq(eventOutbox.dedupeKey, event.dedupeKey));
      expect(outboxRows).toHaveLength(0);

      const conditions = [
        eq(activityLog.companyId, companyA),
        eq(activityLog.entityId, event.entityId ?? ""),
      ];
      const logRows = await ownerDb
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(...conditions));
      expect(logRows).toHaveLength(0);
    });
  });

  it("dedupes: the same dedupe key records once and the repeat is a no-op success", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const event = criticalEvent(companyA);

    const first = await repo.recordCriticalEvent(event);
    const second = await repo.recordCriticalEvent({ ...event, entityAction: "retried" });
    expect(second.isSuccess).toBe(true);
    expect(second.wasDuplicate).toBe(true);
    expect(second.outboxId).toBe(first.outboxId);
    expect(second.activityLogId).toBe(first.activityLogId);

    await withOwnerDb(async (ownerDb) => {
      const outboxConditions = [
        eq(eventOutbox.companyId, companyA),
        eq(eventOutbox.dedupeKey, event.dedupeKey),
      ];
      const outboxRows = await ownerDb
        .select({ id: eventOutbox.id })
        .from(eventOutbox)
        .where(and(...outboxConditions));
      expect(outboxRows).toHaveLength(1);

      const logConditions = [
        eq(activityLog.companyId, companyA),
        eq(activityLog.entityId, event.entityId ?? ""),
      ];
      const logRows = await ownerDb
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(...logConditions));
      expect(logRows).toHaveLength(1);
    });
  });

  it("scopes the dedupe key to one company", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const dedupeKey = `test:${crypto.randomUUID()}`;

    const inA = await repo.recordCriticalEvent(criticalEvent(companyA, { dedupeKey }));
    const inB = await repo.recordCriticalEvent(criticalEvent(companyB, { dedupeKey }));
    expect(inB.isSuccess).toBe(true);
    expect(inB.wasDuplicate).toBe(false);
    expect(inB.outboxId).not.toBe(inA.outboxId);
  });

  it("checks parent and root log references within the company", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const rootInA = await repo.recordCriticalEvent(criticalEvent(companyA));
    const rootInB = await repo.recordCriticalEvent(criticalEvent(companyB));

    const child = await repo.recordCriticalEvent(
      criticalEvent(companyA, {
        parentLogId: rootInA.activityLogId ?? "",
        rootLogId: rootInA.activityLogId ?? "",
      }),
    );
    expect(child.isSuccess).toBe(true);

    const dangling = criticalEvent(companyA, { parentLogId: "999999999999" });
    const danglingResult = await repo.recordCriticalEvent(dangling);
    expect(danglingResult.isSuccess).toBe(false);
    expect(danglingResult.message).toBe("Parent activity log not found");

    const crossCompany = criticalEvent(companyA, { rootLogId: rootInB.activityLogId ?? "" });
    const crossCompanyResult = await repo.recordCriticalEvent(crossCompany);
    expect(crossCompanyResult.isSuccess).toBe(false);
    expect(crossCompanyResult.message).toBe("Root activity log not found");

    const outboxRows = await withOwnerDb((ownerDb) =>
      ownerDb
        .select({ id: eventOutbox.id })
        .from(eventOutbox)
        .where(inArray(eventOutbox.dedupeKey, [dangling.dedupeKey, crossCompany.dedupeKey])),
    );
    expect(outboxRows).toHaveLength(0);
  });
});

describe("EventOutboxRepo relay", () => {
  it("publishes after commit and marks the row published; a second relay sends nothing", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const event = criticalEvent(companyA);
    const recorded = await repo.recordCriticalEvent(event);
    const outboxId = recorded.outboxId ?? "";

    const relayed = await repo.relayEvents({ companyId: companyA, outboxIds: [outboxId] });
    expect(relayed.isSuccess).toBe(true);
    expect(relayed.publishedCount).toBe(1);
    expect(queue.sentFor(outboxId)).toEqual([
      {
        outboxId,
        companyId: companyA,
        activityLogId: recorded.activityLogId,
        eventType: event.eventType,
        dedupeKey: event.dedupeKey,
      },
    ]);

    const row = await getOutboxRow(outboxId);
    expect(row?.status).toBe(Schemas.EventOutboxStatusIntEnum.Published);
    expect(row?.publishedAt).toBeInstanceOf(Date);

    const again = await repo.relayEvents({ companyId: companyA, outboxIds: [outboxId] });
    expect(again.publishedCount).toBe(0);
    expect(queue.sentFor(outboxId)).toHaveLength(1);
  });

  it("killed relay: the Cron sweep publishes the pending row the after-commit relay never sent", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const stale = await repo.recordCriticalEvent(criticalEvent(companyA));
    const fresh = await repo.recordCriticalEvent(criticalEvent(companyB));
    // DEV_NOTE: No relayEvents call: the isolate died before waitUntil ran. Only the stale row is old enough to sweep.
    await backdateOutboxRow(stale.outboxId ?? "", Constants.OUTBOX_SWEEP_MIN_AGE_MS * 2);

    await runOutboxSweep(repoEnv());

    expect(queue.sentFor(stale.outboxId ?? "")).toHaveLength(1);
    expect((await getOutboxRow(stale.outboxId ?? ""))?.status).toBe(
      Schemas.EventOutboxStatusIntEnum.Published,
    );
    expect(queue.sentFor(fresh.outboxId ?? "")).toHaveLength(0);
    expect((await getOutboxRow(fresh.outboxId ?? ""))?.status).toBe(
      Schemas.EventOutboxStatusIntEnum.Pending,
    );
  });

  it("dedupe holds when the relay and the sweep race for the same row: one send", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const recorded = await repo.recordCriticalEvent(criticalEvent(companyA));
    const outboxId = recorded.outboxId ?? "";
    await backdateOutboxRow(outboxId, Constants.OUTBOX_SWEEP_MIN_AGE_MS * 2);

    // DEV_NOTE: The relay locks the row and stalls inside sendBatch; the sweep runs meanwhile and must skip it
    const { entered, release } = queue.holdNextSend();
    const relaying = repo.relayEvents({ companyId: companyA, outboxIds: [outboxId] });
    await entered;

    const swept = await new EventOutboxRepo(repoEnv()).sweepPendingEvents();
    expect(swept.isSuccess).toBe(true);
    expect(queue.sentFor(outboxId)).toHaveLength(0);

    release();
    const relayed = await relaying;
    expect(relayed.publishedCount).toBe(1);
    expect(queue.sentFor(outboxId)).toHaveLength(1);
    expect((await getOutboxRow(outboxId))?.status).toBe(Schemas.EventOutboxStatusIntEnum.Published);
  });

  it("counts failed sends, then marks the row Failed and alerts at the attempt cap", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const recorded = await repo.recordCriticalEvent(criticalEvent(companyA));
    const outboxId = recorded.outboxId ?? "";
    queue.failWith = new Error("Queue unavailable");

    for (let attempt = 1; attempt < Constants.OUTBOX_MAX_ATTEMPTS; attempt++) {
      const relayed = await repo.relayEvents({ companyId: companyA, outboxIds: [outboxId] });
      expect(relayed.isSuccess).toBe(false);
      expect(relayed.failedCount).toBe(1);

      const row = await getOutboxRow(outboxId);
      expect(row?.status).toBe(Schemas.EventOutboxStatusIntEnum.Pending);
      expect(row?.attempts).toBe(attempt);
      expect(row?.lastError).toBe("Queue unavailable");
    }

    vi.mocked(AppLogger.error).mockClear();
    await repo.relayEvents({ companyId: companyA, outboxIds: [outboxId] });
    const failed = await getOutboxRow(outboxId);
    expect(failed?.status).toBe(Schemas.EventOutboxStatusIntEnum.Failed);
    expect(failed?.attempts).toBe(Constants.OUTBOX_MAX_ATTEMPTS);
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        category: Schemas.LogCategory.Relay,
        message: `Events failed after ${Constants.OUTBOX_MAX_ATTEMPTS} attempts`,
      }),
    );

    // DEV_NOTE: A Failed row is left for the runbook, never retried automatically
    queue.failWith = null;
    const afterFailed = await repo.relayEvents({ companyId: companyA, outboxIds: [outboxId] });
    expect(afterFailed.publishedCount).toBe(0);
    expect(queue.sentFor(outboxId)).toHaveLength(0);
  });

  it("can't relay another company's outbox rows", async () => {
    const repo = new EventOutboxRepo(repoEnv());
    const recorded = await repo.recordCriticalEvent(criticalEvent(companyA));
    const outboxId = recorded.outboxId ?? "";

    const relayed = await repo.relayEvents({ companyId: companyB, outboxIds: [outboxId] });
    expect(relayed.isSuccess).toBe(true);
    expect(relayed.publishedCount).toBe(0);
    expect(queue.sentFor(outboxId)).toHaveLength(0);
    expect((await getOutboxRow(outboxId))?.status).toBe(Schemas.EventOutboxStatusIntEnum.Pending);
  });

  it("purges published rows past retention and keeps pending, failed and recent rows", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const oldDate = new Date(Date.now() - (Constants.OUTBOX_PUBLISHED_RETENTION_DAYS + 1) * dayMs);
    const recentDate = new Date(Date.now() - dayMs);

    const ids = await withOwnerDb(async (ownerDb) => {
      const insert = async (values: Partial<typeof eventOutbox.$inferInsert>) => {
        const [row] = await ownerDb
          .insert(eventOutbox)
          .values({
            companyId: companyA,
            activityLogId: randomEntityId(),
            eventType: "purge_test",
            dedupeKey: `test:${crypto.randomUUID()}`,
            createdAt: oldDate,
            ...values,
          })
          .returning({ id: eventOutbox.id });
        return row?.id ?? "";
      };
      return {
        oldPublished: await insert({
          status: Schemas.EventOutboxStatusIntEnum.Published,
          publishedAt: oldDate,
        }),
        recentPublished: await insert({
          status: Schemas.EventOutboxStatusIntEnum.Published,
          publishedAt: recentDate,
        }),
        oldPending: await insert({}),
        oldFailed: await insert({ status: Schemas.EventOutboxStatusIntEnum.Failed }),
      };
    });

    const purged = await new EventOutboxRepo(repoEnv()).purgePublishedEvents();
    expect(purged.isSuccess).toBe(true);
    expect(purged.deletedCount).toBeGreaterThanOrEqual(1);

    expect(await getOutboxRow(ids.oldPublished)).toBeUndefined();
    expect(await getOutboxRow(ids.recentPublished)).toBeDefined();
    expect(await getOutboxRow(ids.oldPending)).toBeDefined();
    expect(await getOutboxRow(ids.oldFailed)).toBeDefined();
  });
});

describe("EventsConsumer", () => {
  const message = (body: unknown) => ({
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  });
  const batchOf = (messages: ReturnType<typeof message>[]): MessageBatch<unknown> => ({
    messages,
    queue: "diletta-events-staging",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  });

  it("acks each valid event and acks an invalid body without a retry", async () => {
    const valid = message({
      outboxId: "1",
      companyId: companyA,
      activityLogId: "2",
      eventType: "change_request.verified",
      dedupeKey: "test:consumer",
    });
    const invalid = message({ outboxId: 1 });

    await consumeEvents(batchOf([valid, invalid]));

    expect(valid.ack).toHaveBeenCalledOnce();
    expect(valid.retry).not.toHaveBeenCalled();
    expect(invalid.ack).toHaveBeenCalledOnce();
    expect(invalid.retry).not.toHaveBeenCalled();
    expect(AppLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        action: Schemas.LogAction.ConsumeEvent,
        message: "Event received",
      }),
    );
    expect(AppLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        action: Schemas.LogAction.ConsumeEvent,
        message: "Invalid event message",
      }),
    );
  });
});

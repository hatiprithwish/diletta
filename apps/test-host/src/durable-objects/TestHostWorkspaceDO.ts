import { DurableObject } from "cloudflare:workers";
import * as Schemas from "@app/schemas";

const RECORD_PREFIX = "record:";
const RESULT_PREFIX = "result:";
const FAULTS_KEY = "faults";

const WRITE_KINDS = new Set<Schemas.TestHostOperationKindEnum>([
  Schemas.TestHostOperationKindEnum.Create,
  Schemas.TestHostOperationKindEnum.Update,
  Schemas.TestHostOperationKindEnum.Put,
  Schemas.TestHostOperationKindEnum.Delete,
  Schemas.TestHostOperationKindEnum.Reset,
]);

const answer = (status: number, body: object | null): Schemas.TestHostWorkspaceResponse => ({
  status,
  body: body === null ? null : JSON.stringify(body),
});
function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const refusal = (status: number, error: string) =>
  answer(status, { error } satisfies Schemas.TestHostErrorBody);

// DEV_NOTE: One test host workspace (M3-3), named by the host token's ws claim: its records, its stored Native results
// and its fault queue, in the SQLite kv. Every RPC is parsed first, and runs with no await, so a request, its fault and
// its stored result are one atomic step (two retries of the same key can't both write). Reached only through
// TestHostWorkspaceDO.forWorkspace from the routes.
export class TestHostWorkspaceDO extends DurableObject<Env> {
  static forWorkspace(env: Env, workspace: string): DurableObjectStub<TestHostWorkspaceDO> {
    return env.TEST_HOST_WORKSPACE_DO.getByName(workspace);
  }

  // DEV_NOTE: Order: take the first matching fault; a fault that isn't applied answers before anything runs; else the
  // request runs (replaying a stored result for a known key); then an applied status fault replaces the answer, an
  // overwrite edits the touched record, a delay holds the answer.
  async run(raw: Schemas.TestHostWorkspaceRequest): Promise<Schemas.TestHostWorkspaceResponse> {
    const parsed = Schemas.ZTestHostWorkspaceRequest.safeParse(raw);
    if (!parsed.success) return refusal(400, "Invalid request");
    const request = parsed.data;

    const fault = this.takeFault(request.method, request.path);
    if (fault?.kind === Schemas.TestHostFaultKindEnum.Status && !fault.isApplied) {
      return this.injected(fault);
    }

    const result = this.runOnce(request);

    switch (fault?.kind) {
      case Schemas.TestHostFaultKindEnum.Status:
        return this.injected(fault);
      case Schemas.TestHostFaultKindEnum.Overwrite:
        this.overwrite(request.operation, result, fault.fields);
        return result;
      case Schemas.TestHostFaultKindEnum.Delay:
        return { ...result, delayMs: fault.ms };
      default:
        return result;
    }
  }

  async setFaults(raw: Schemas.TestHostSetFaultsRequest): Promise<Schemas.ApiResponse> {
    const parsed = Schemas.ZTestHostSetFaultsRequest.safeParse(raw);
    if (!parsed.success) return { isSuccess: false, message: "Invalid faults" };
    this.ctx.storage.kv.put(FAULTS_KEY, parsed.data.faults);
    return { isSuccess: true, message: "Faults set" };
  }

  async getFaults(): Promise<Schemas.TestHostFault[]> {
    return this.readFaults();
  }

  // DEV_NOTE: A write with an Idempotency-Key runs once per key: the same key and request again answer the stored
  // result; the same key with another request is 422 (draft-ietf-httpapi-idempotency-key-header). Results below 500 are
  // kept TEST_HOST_IDEMPOTENCY_TTL_MS; reads ignore the key.
  private runOnce(request: Schemas.TestHostWorkspaceRequest): Schemas.TestHostWorkspaceResponse {
    const { idempotencyKey, operation } = request;
    if (idempotencyKey === null || !WRITE_KINDS.has(operation.kind)) {
      return this.execute(operation);
    }

    const now = Date.now();
    this.pruneResults(now);
    const fingerprint = JSON.stringify([request.method, request.path, operation]);
    const storageKey = `${RESULT_PREFIX}${idempotencyKey}`;
    const stored = Schemas.ZTestHostStoredResult.safeParse(this.ctx.storage.kv.get(storageKey));
    if (stored.success) {
      if (stored.data.fingerprint !== fingerprint) {
        return refusal(422, "Idempotency-Key was used for a different request");
      }
      return { status: stored.data.status, body: stored.data.body };
    }

    const result = this.execute(operation);
    if (result.status < 500) {
      const entry: Schemas.TestHostStoredResult = {
        fingerprint,
        status: result.status,
        body: result.body,
        storedAt: now,
      };
      this.ctx.storage.kv.put(storageKey, entry);
    }
    return result;
  }

  private execute(operation: Schemas.TestHostOperation): Schemas.TestHostWorkspaceResponse {
    switch (operation.kind) {
      case Schemas.TestHostOperationKindEnum.List: {
        const records = this.listRecords()
          .filter((record) => !operation.query.status || record.status === operation.query.status)
          .slice(0, operation.query.limit);
        return answer(200, { data: records });
      }
      case Schemas.TestHostOperationKindEnum.Get: {
        const record = this.getRecord(operation.id);
        return record ? answer(200, { data: record }) : refusal(404, "Record not found");
      }
      case Schemas.TestHostOperationKindEnum.Create: {
        if (this.isFull()) return refusal(409, "Workspace is full");
        const record = this.normalize({
          id: `rec_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
          ...operation.record,
          status: operation.record.status ?? Schemas.TestHostRecordStatusEnum.Active,
        });
        this.putRecord(record);
        return answer(201, { data: record });
      }
      case Schemas.TestHostOperationKindEnum.Update: {
        const record = this.getRecord(operation.id);
        if (!record) return refusal(404, "Record not found");
        const updated = this.normalize({ ...record, ...operation.fields });
        this.putRecord(updated);
        return answer(200, { data: updated });
      }
      case Schemas.TestHostOperationKindEnum.Put: {
        const existing = this.getRecord(operation.id);
        if (!existing && this.isFull()) return refusal(409, "Workspace is full");
        const record = this.normalize({
          id: operation.id,
          ...operation.record,
          status: operation.record.status ?? Schemas.TestHostRecordStatusEnum.Active,
        });
        this.putRecord(record);
        return answer(existing ? 200 : 201, { data: record });
      }
      case Schemas.TestHostOperationKindEnum.Delete: {
        if (!this.getRecord(operation.id)) return refusal(404, "Record not found");
        this.ctx.storage.kv.delete(`${RECORD_PREFIX}${operation.id}`);
        return answer(204, null);
      }
      case Schemas.TestHostOperationKindEnum.Reset: {
        // DEV_NOTE: Back to the fixed starting state: seed records only, no stored results, no faults
        for (const prefix of [RECORD_PREFIX, RESULT_PREFIX]) {
          for (const [key] of this.ctx.storage.kv.list({ prefix })) this.ctx.storage.kv.delete(key);
        }
        this.ctx.storage.kv.delete(FAULTS_KEY);
        for (const record of Schemas.TEST_HOST_SEED_RECORDS) this.putRecord({ ...record });
        return answer(200, { data: this.listRecords() });
      }
    }
  }

  // DEV_NOTE: The record a request touched: its id, or a created record's id from the answer. A record that is gone
  // (deleted) isn't brought back.
  private overwrite(
    operation: Schemas.TestHostOperation,
    result: Schemas.TestHostWorkspaceResponse,
    fields: Partial<Omit<Schemas.TestHostRecord, "id">>,
  ) {
    const id =
      "id" in operation
        ? operation.id
        : Schemas.ZTestHostRecordResponse.safeParse(parseJson(result.body)).data?.data.id;
    const record = id ? this.getRecord(id) : null;
    if (record) this.putRecord(this.normalize({ ...record, ...fields }));
  }

  private takeFault(method: string, path: string): Schemas.TestHostFault | null {
    const faults = this.readFaults();
    const index = faults.findIndex(
      (fault) =>
        (fault.method === undefined || fault.method === method) &&
        (fault.path === undefined || fault.path === path),
    );
    if (index === -1) return null;
    const [fault] = faults.splice(index, 1);
    this.ctx.storage.kv.put(FAULTS_KEY, faults);
    return fault ?? null;
  }

  private injected(
    fault: Extract<Schemas.TestHostFault, { kind: Schemas.TestHostFaultKindEnum.Status }>,
  ): Schemas.TestHostWorkspaceResponse {
    return {
      ...refusal(fault.status, "Injected fault"),
      ...(fault.retryAfterSeconds !== undefined && { retryAfterSeconds: fault.retryAfterSeconds }),
    };
  }

  private readFaults(): Schemas.TestHostFault[] {
    const parsed = Schemas.ZTestHostSetFaultsRequest.shape.faults.safeParse(
      this.ctx.storage.kv.get(FAULTS_KEY),
    );
    return parsed.success ? parsed.data : [];
  }

  // The host stores email lowercased (the "stored in another form" case)
  private normalize(record: Schemas.TestHostRecord): Schemas.TestHostRecord {
    return { ...record, email: record.email.toLowerCase() };
  }

  private listRecords(): Schemas.TestHostRecord[] {
    const records: Schemas.TestHostRecord[] = [];
    for (const [, value] of this.ctx.storage.kv.list({ prefix: RECORD_PREFIX })) {
      const parsed = Schemas.ZTestHostRecord.safeParse(value);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  private getRecord(id: string): Schemas.TestHostRecord | null {
    const parsed = Schemas.ZTestHostRecord.safeParse(
      this.ctx.storage.kv.get(`${RECORD_PREFIX}${id}`),
    );
    return parsed.success ? parsed.data : null;
  }

  private putRecord(record: Schemas.TestHostRecord) {
    this.ctx.storage.kv.put(`${RECORD_PREFIX}${record.id}`, record);
  }

  private isFull(): boolean {
    const count = [...this.ctx.storage.kv.list({ prefix: RECORD_PREFIX })].length;
    return count >= Schemas.TEST_HOST_MAX_RECORDS;
  }

  private pruneResults(now: number) {
    for (const [key, value] of this.ctx.storage.kv.list({ prefix: RESULT_PREFIX })) {
      const parsed = Schemas.ZTestHostStoredResult.safeParse(value);
      if (!parsed.success || now - parsed.data.storedAt > Schemas.TEST_HOST_IDEMPOTENCY_TTL_MS) {
        this.ctx.storage.kv.delete(key);
      }
    }
  }
}

import * as Schemas from "@app/schemas";

// DEV_NOTE: The test host's fault rules, pure (no storage) so they are unit-tested on their own; TestHostWorkspaceDO
// reads and writes the queue around them, like BudgetDO around BudgetLedgerProvider.
export default class TestHostFaultsProvider {
  // DEV_NOTE: The first queued fault whose method and path (either omitted = any) match the request. It is used up by
  // that request whatever happens next (a refused write overwrites nothing, but its fault is gone).
  static take(
    faults: Schemas.TestHostFault[],
    method: Schemas.ToolOpMethodEnum,
    path: string,
  ): Schemas.TestHostFaultTake {
    const index = faults.findIndex(
      (fault) =>
        (fault.method === undefined || fault.method === method) &&
        (fault.path === undefined || fault.path === path),
    );
    if (index === -1) return { fault: null, remaining: faults };
    return {
      fault: faults[index] ?? null,
      remaining: [...faults.slice(0, index), ...faults.slice(index + 1)],
    };
  }

  // DEV_NOTE: The record an overwrite fault edits: only after a write that ran now (not a replayed Idempotency-Key
  // result) and succeeded (2xx). Update and put touch their id, create the id in its answer. A refused write, a read,
  // a delete (the record is gone) and a reset touch nothing, so the fault changes nothing.
  static getOverwriteTarget(
    operation: Schemas.TestHostOperation,
    run: Schemas.TestHostRunResult,
  ): string | null {
    const { status, body } = run.response;
    if (run.isReplay || status < 200 || status >= 300) return null;

    switch (operation.kind) {
      case Schemas.TestHostOperationKindEnum.Update:
      case Schemas.TestHostOperationKindEnum.Put:
        return operation.id;
      case Schemas.TestHostOperationKindEnum.Create:
        return (
          Schemas.ZTestHostRecordResponse.safeParse(TestHostFaultsProvider.parseJson(body)).data
            ?.data.id ?? null
        );
      default:
        return null;
    }
  }

  private static parseJson(text: string | null): unknown {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

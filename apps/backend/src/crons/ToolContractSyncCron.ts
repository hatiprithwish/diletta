import ToolContractSyncRepo from "@/repositories/ToolContractSyncRepo";

// DEV_NOTE: Every hour (ADR 0009): each connection with an OpenAPI spec URL, least recently synced first (at most
// TOOL_CONTRACT_SYNC_MAX_CONNECTIONS a tick), has its tools' schemas compared with the spec. A changed schema becomes a
// new tool version, a draft setup that uses it and a Tool update issue; nothing is published. Goes through the Repo,
// which logs its own failures (an alert). Idempotent: a missed tick is done by the next.
export default async function runToolContractSync(env: Env): Promise<void> {
  await new ToolContractSyncRepo(env).sweep();
}

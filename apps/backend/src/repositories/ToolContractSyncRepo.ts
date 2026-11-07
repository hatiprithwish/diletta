import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import CompanyConnectionsDAL from "@/data-access-layer/CompanyConnectionsDAL";
import ToolDefinitionsDAL from "@/data-access-layer/ToolDefinitionsDAL";
import getDbClient from "@/db/dbClient";
import withPlatform from "@/db/withPlatform";
import withTenant, { TenantRollbackError } from "@/db/withTenant";
import HostToolCallProvider from "@/providers/hostToolCall";
import AppLogger from "@/providers/logger";
import ToolContractProvider from "@/providers/toolContract";
import ToolContractUpdateProvider from "@/providers/toolContractUpdate";
import EventOutboxRepo from "@/repositories/EventOutboxRepo";
import {
  recordAuditOrRollback,
  recordAuditsOrRollback,
  systemAuditActor,
} from "@/repositories/audit";
import Utility from "@/utils/Utility";
import * as Schemas from "@app/schemas";

// DEV_NOTE: Tool contract sync (ADR 0009). A tool's input_schema follows its company's OpenAPI spec; the binding (ops,
// risk, approval) stays an operator's. Per connection with a spec URL:
//   1. The spec is fetched through the adapter and read BEFORE any transaction (a slow host never holds one). A spec
//      that can't be fetched or read, or whose hash is the one already read (and the last sync was fine), changes nothing.
//   2. One withTenant on the company: the connection's bound tools are locked by name, their newest versions read, and
//      each schema derived from the spec (ToolContractProvider). A tool whose derived schema's hash differs gets a new
//      Active version (the old stays Active, so no live chatbot changes); a Draft version (an operator is editing it) or a
//      tool that can't be derived is left alone and reported.
//   3. In that same transaction ToolContractUpdateProvider bumps the pins in each affected chatbot's draft (never a
//      published one) and raises its Tool update issue; every write has a System audit row; the connection records the
//      sync (hash, time, failure).
// A failure (fetch, spec, a tool's operation gone, a schema we can't check) is an alert: AppLogger.error → Sentry, never a
// call to Slack. isDryRun reads and derives everything and writes nothing. The hourly sweep runs oldest-synced first, at
// most TOOL_CONTRACT_SYNC_MAX_CONNECTIONS a tick; every step is safe to miss and to repeat (a repeat finds the same hash).
type SyncScope = {
  companyId: string;
  connectionId: string;
  connectionPublicId: string;
  openapiUrl: string;
  openapiShaping: unknown;
  lastSpecHash: string | null;
  lastFailure: Schemas.ToolContractSyncFailureIntEnum | null;
  isDryRun: boolean;
};

export default class ToolContractSyncRepo {
  private db: NodePgDatabase;
  private connectionsDal: CompanyConnectionsDAL;
  private toolsDal: ToolDefinitionsDAL;
  private outbox: EventOutboxRepo;

  constructor(env: Env) {
    this.db = getDbClient(env);
    this.connectionsDal = new CompanyConnectionsDAL();
    this.toolsDal = new ToolDefinitionsDAL();
    this.outbox = new EventOutboxRepo(env, this.db);
  }

  // DEV_NOTE: The hourly job. One connection failing never stops the others.
  async sweep(): Promise<{ isSuccess: boolean; message: string; synced: number }> {
    let due: Schemas.ToolContractDueConnection[] = [];
    const listed = await withPlatform(this.db, async (tx) => {
      const result = await this.connectionsDal.getToolContractDueConnections(tx, {
        limit: Schemas.TOOL_CONTRACT_SYNC_MAX_CONNECTIONS,
        syncedBefore: new Date(Date.now() - Schemas.TOOL_CONTRACT_SYNC_MIN_INTERVAL_MS),
      });
      due = result.connections ?? [];
      return result;
    });
    if (!listed.isSuccess) return { isSuccess: false, message: listed.message ?? "", synced: 0 };

    let synced = 0;
    for (const connection of due) {
      if (!connection.openapiUrl) continue;
      const result = await this.syncConnection({
        companyId: connection.companyId,
        connectionId: connection.id,
        connectionPublicId: connection.publicId,
        openapiUrl: connection.openapiUrl,
        openapiShaping: connection.openapiShaping,
        lastSpecHash: connection.openapiSpecHash,
        lastFailure: connection.openapiFailure,
        isDryRun: false,
      });
      if (result.isSuccess) synced += 1;
    }
    return { isSuccess: true, message: "Tool contract sync done", synced };
  }

  // DEV_NOTE: One connection on demand (an operator's check or sync), by the company and its connection's public id
  async syncOne(params: {
    companyId: string;
    connectionPublicId: string;
    isDryRun: boolean;
  }): Promise<Schemas.SyncToolContractApiResponse> {
    const read = await withTenant(this.db, params.companyId, async (tx) => {
      const found = await this.toolsDal.getToolConnection(tx, {
        companyId: params.companyId,
        connectionPublicId: params.connectionPublicId,
      });
      return found;
    });
    const connection = "connection" in read ? read.connection : undefined;
    if (!read.isSuccess) return { isSuccess: false, message: read.message };
    if (!connection) return { isSuccess: false, message: "Connection not found", isNotFound: true };
    if (!connection.openapiUrl) {
      return { isSuccess: false, message: "The connection has no OpenAPI spec URL" };
    }
    return await this.syncConnection({
      companyId: params.companyId,
      connectionId: connection.id,
      connectionPublicId: params.connectionPublicId,
      openapiUrl: connection.openapiUrl,
      openapiShaping: connection.openapiShaping,
      // An operator's sync always derives: the point may be to retry after fixing a binding
      lastSpecHash: null,
      lastFailure: null,
      isDryRun: params.isDryRun,
    });
  }

  private async syncConnection(scope: SyncScope): Promise<Schemas.SyncToolContractApiResponse> {
    const fetched = await HostToolCallProvider.getSpec({ url: scope.openapiUrl });
    if (!fetched.isSuccess) {
      return await this.fail(
        scope,
        Schemas.ToolContractSyncFailureIntEnum.FetchFailed,
        fetched.message,
      );
    }
    const parsed = Schemas.parseOpenApiSpec(fetched.body);
    if (!parsed.isSuccess) return await this.fail(scope, parsed.failure, parsed.message);
    const specHash = await Utility.sha256Hex(Utility.stableStringify(fetched.body));

    if (!scope.isDryRun && specHash === scope.lastSpecHash && scope.lastFailure === null) {
      await this.recordOnly(scope, { failure: null, specHash });
      return { isSuccess: true, message: "The spec hasn't changed", isUnchanged: true };
    }

    const synced = await withTenant(this.db, scope.companyId, async (tx) => {
      const names = await this.toolsDal.getBoundToolNames(tx, scope);
      if (!names.isSuccess || !names.names) throw new TenantRollbackError(names.message ?? "");
      const response: Schemas.SyncToolContractApiResponse & { outboxIds: string[] } = {
        isSuccess: true,
        message: "Tools synced",
        isDryRun: scope.isDryRun,
        changes: [],
        skipped: [],
        problems: [],
        outboxIds: [],
      };
      let failure: Schemas.ToolContractSyncFailureIntEnum | null = null;
      const setFailure = (next: Schemas.ToolContractSyncFailureIntEnum) => {
        failure ??= next;
      };

      if (names.names.length > 0) {
        const locked = await this.toolsDal.lockToolDefinitionNames(tx, {
          companyId: scope.companyId,
          names: names.names,
        });
        if (!locked.isSuccess) throw new TenantRollbackError(locked.message ?? "");
        const latest = await this.toolsDal.getLatestToolDefinitions(tx, {
          companyId: scope.companyId,
          names: names.names,
        });
        if (!latest.isSuccess || !latest.toolDefinitions) {
          throw new TenantRollbackError(latest.message ?? "");
        }

        const eligible: { row: Schemas.ToolDefinitionRow; ops: Schemas.ToolOps }[] = [];
        for (const row of latest.toolDefinitions) {
          // DEV_NOTE: A Draft is an operator's work in progress; a name whose newest version is on another connection or
          // was never bound isn't this connection's to move
          if (
            row.status === Schemas.ToolDefinitionStatusIntEnum.Draft ||
            row.connectionId !== scope.connectionId ||
            row.operationId === null
          ) {
            response.skipped?.push(row.name);
            continue;
          }
          const loaded = Schemas.loadToolOps({
            schemaVersion: row.schemaVersion,
            ops: {
              inputSchema: row.inputSchema,
              callOp: row.callOp,
              readbackOp: row.readbackOp,
              inverseOp: row.inverseOp,
            },
          });
          if (!loaded.isSuccess || !loaded.ops) {
            response.problems?.push(`${row.name}: its stored ops don't load`);
            setFailure(Schemas.ToolContractSyncFailureIntEnum.ServerError);
            continue;
          }
          eligible.push({ row, ops: loaded.ops });
        }

        const derived = await ToolContractProvider.derive({
          spec: parsed.spec,
          shaping: ToolContractProvider.shapingOf(scope.openapiShaping),
          tools: eligible.map(({ row, ops }) => ({
            name: row.name,
            risk: row.risk,
            ops,
            operationId: row.operationId,
          })),
        });

        const newVersions: Schemas.CreateToolDefinitionsDALRequest["toolDefinitions"] = [];
        const updates: Schemas.ToolUpdateEntry[] = [];
        for (const [index, result] of derived.entries()) {
          const current = eligible[index];
          if (!current) continue;
          if (!result.isSuccess) {
            response.problems?.push(result.message);
            setFailure(result.failure);
            continue;
          }
          if (result.contractHash === current.row.contractHash) continue;
          const normalized = Schemas.normalizeToolOps({
            ...current.ops,
            inputSchema: result.inputSchema,
          });
          const issue = normalized.ops
            ? Schemas.getToolOpsIssue(current.row.risk, current.row.idempotencyMode, normalized.ops)
            : normalized.message;
          if (!normalized.ops || normalized.schemaVersion === undefined || issue) {
            response.problems?.push(`${current.row.name}: ${issue ?? normalized.message}`);
            setFailure(Schemas.ToolContractSyncFailureIntEnum.SchemaUnenforceable);
            continue;
          }
          const classified = Schemas.classifyToolSchemaChange(
            current.ops.inputSchema,
            normalized.ops.inputSchema,
          );
          const toVersion = current.row.version + 1;
          response.changes?.push({
            name: current.row.name,
            fromVersion: current.row.version,
            toVersion: scope.isDryRun ? null : toVersion,
            change: classified.change,
            notes: classified.notes,
          });
          newVersions.push({
            connectionId: current.row.connectionId,
            name: current.row.name,
            version: toVersion,
            description: current.row.description,
            risk: current.row.risk,
            schemaVersion: normalized.schemaVersion,
            inputSchema: normalized.ops.inputSchema,
            callOp: normalized.ops.callOp,
            readbackOp: normalized.ops.readbackOp,
            inverseOp: normalized.ops.inverseOp,
            idempotencyMode: current.row.idempotencyMode,
            approval: current.row.approval,
            source: current.row.source,
            operationId: result.operationId,
            contractHash: result.contractHash,
          });
          updates.push({
            name: current.row.name,
            fromVersion: current.row.version,
            toVersion,
            change: classified.change,
          });
        }

        if (!scope.isDryRun && newVersions.length > 0) {
          const created = await this.toolsDal.createToolDefinitions(tx, {
            companyId: scope.companyId,
            createdBy: null,
            status: Schemas.ToolDefinitionStatusIntEnum.Active,
            toolDefinitions: newVersions,
          });
          if (!created.isSuccess || !created.toolDefinitions) {
            throw new TenantRollbackError(created.message ?? "Tool versions weren't created");
          }
          response.outboxIds.push(
            ...(await recordAuditsOrRollback(tx, {
              companyId: scope.companyId,
              actor: systemAuditActor(),
              entityType: Schemas.AuditEntityTypeEnum.ToolDefinition,
              events: created.toolDefinitions.flatMap((row) => [
                {
                  entityAction: Schemas.AuditEntityActionEnum.VersionCreated as const,
                  entity: row,
                  entityVersion: row.version,
                  label: row.name,
                },
                {
                  entityAction: Schemas.AuditEntityActionEnum.Activated as const,
                  entity: row,
                  entityVersion: row.version,
                  label: row.name,
                },
              ]),
            })),
          );

          const applied = await ToolContractUpdateProvider.apply(tx, {
            companyId: scope.companyId,
            updates,
          });
          if (!applied.isSuccess) throw new TenantRollbackError(applied.message ?? "");
          response.outboxIds.push(...applied.outboxIds);
          for (const change of applied.configChanges) {
            response.outboxIds.push(
              await recordAuditOrRollback(tx, {
                companyId: scope.companyId,
                actor: systemAuditActor(),
                entityType: Schemas.AuditEntityTypeEnum.ChatbotConfig,
                entityAction: change.action,
                entity: change.chatbotConfig,
                entityVersion: change.chatbotConfig.configVersion,
                label: Schemas.chatbotConfigLabel(
                  change.chatbotName,
                  change.chatbotConfig.configVersion,
                ),
              }),
            );
          }
        }
      }

      response.failure = failure ?? undefined;
      if (!scope.isDryRun) {
        const recorded = await this.connectionsDal.recordToolContractSync(tx, {
          companyId: scope.companyId,
          publicId: scope.connectionPublicId,
          openapiFailure: failure,
          openapiSpecHash: specHash,
        });
        if (!recorded.isSuccess) throw new TenantRollbackError(recorded.message ?? "");
      }
      return response;
    });

    if (!("changes" in synced)) {
      return await this.fail(
        scope,
        Schemas.ToolContractSyncFailureIntEnum.ServerError,
        synced.message ?? "",
      );
    }
    const { outboxIds, ...answer } = synced;
    if (outboxIds.length > 0) {
      await this.outbox.relayEvents({ companyId: scope.companyId, outboxIds });
    }
    this.alert(scope, answer);
    return answer;
  }

  // DEV_NOTE: A failure that changed nothing: recorded on the connection (the sweep rotates on it) and alerted. A dry run
  // writes nothing.
  private async fail(
    scope: SyncScope,
    failure: Schemas.ToolContractSyncFailureIntEnum,
    message: string,
  ): Promise<Schemas.SyncToolContractApiResponse> {
    if (!scope.isDryRun) await this.recordOnly(scope, { failure, specHash: undefined });
    AppLogger.error({
      category: Schemas.LogCategory.Repo,
      action: Schemas.LogAction.SyncToolContracts,
      message: "Tool contract sync failed",
      metadata: {
        companyId: scope.companyId,
        connectionPublicId: scope.connectionPublicId,
        failure: Schemas.TOOL_CONTRACT_SYNC_FAILURE_LABEL_MAP[failure],
        reason: message,
      },
    });
    return { isSuccess: false, message, failure, isDryRun: scope.isDryRun };
  }

  private async recordOnly(
    scope: SyncScope,
    params: {
      failure: Schemas.ToolContractSyncFailureIntEnum | null;
      specHash: string | undefined;
    },
  ): Promise<void> {
    await withTenant(this.db, scope.companyId, async (tx) => {
      return await this.connectionsDal.recordToolContractSync(tx, {
        companyId: scope.companyId,
        publicId: scope.connectionPublicId,
        openapiFailure: params.failure,
        openapiSpecHash: params.specHash,
      });
    });
  }

  // DEV_NOTE: An alert is an error log (Sentry → Slack), names and kinds only: a tool the spec no longer has, or one
  // whose new schema we can't check. A breaking change is a warning (the Tool update issue is what the admin sees).
  private alert(scope: SyncScope, answer: Schemas.SyncToolContractApiResponse): void {
    if (scope.isDryRun) return;
    if (answer.failure !== undefined) {
      AppLogger.error({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.SyncToolContracts,
        message: "Tool contract sync left tools unchanged",
        metadata: {
          companyId: scope.companyId,
          connectionPublicId: scope.connectionPublicId,
          failure: Schemas.TOOL_CONTRACT_SYNC_FAILURE_LABEL_MAP[answer.failure],
          problems: answer.problems,
        },
      });
    }
    const breaking = answer.changes?.filter(
      (change) => change.change === Schemas.ToolSchemaChangeEnum.Breaking,
    );
    if (breaking && breaking.length > 0) {
      AppLogger.warn({
        category: Schemas.LogCategory.Repo,
        action: Schemas.LogAction.SyncToolContracts,
        message: "Tool contract sync found breaking changes",
        metadata: {
          companyId: scope.companyId,
          connectionPublicId: scope.connectionPublicId,
          tools: breaking.map((change) => change.name),
        },
      });
    }
  }
}

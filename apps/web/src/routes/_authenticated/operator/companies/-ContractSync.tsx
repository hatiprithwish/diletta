import { ArrowsClockwise, MagnifyingGlass } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@app/ui/components/dialog";
import { Skeleton } from "@app/ui/components/skeleton";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import { contractSyncResponse, useSyncToolContract } from "./-data";

const CHANGE_TONE: Record<Schemas.ToolSchemaChangeEnum, Schemas.DashboardChipToneEnum> = {
  [Schemas.ToolSchemaChangeEnum.None]: Schemas.DashboardChipToneEnum.Neutral,
  [Schemas.ToolSchemaChangeEnum.Additive]: Schemas.DashboardChipToneEnum.Success,
  [Schemas.ToolSchemaChangeEnum.Breaking]: Schemas.DashboardChipToneEnum.Warning,
};

// DEV_NOTE: A connection's "OpenAPI spec" row (ADR 0009): the spec URL, when it was last read and why it failed, and the
// two ways to read it now. Check changes reads the spec and writes nothing; Sync now writes what changed, as the hourly
// sync does. The URL and shaping are edited on the connection's own page.
export function ContractSyncRow({
  companyPublicId,
  connection,
}: Schemas.DashboardOperatorContractSyncRowProps) {
  const sync = useSyncToolContract(companyPublicId, connection.publicId);
  const isOpen = sync.isPending || sync.isSuccess || sync.isError;

  if (!connection.openapiUrl) {
    return (
      <span className="text-muted-foreground">
        None. Tools keep the schemas they were loaded with.
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-mono-value break-all">{connection.openapiUrl}</span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption text-muted-foreground">
          {connection.openapiSyncedAt
            ? `Synced ${Utilities.formatTimeAgo(new Date(connection.openapiSyncedAt).toISOString())}`
            : "Not synced yet"}
        </span>
        {connection.openapiFailure !== null && (
          <StatusChip
            label={Schemas.TOOL_CONTRACT_SYNC_FAILURE_LABEL_MAP[connection.openapiFailure]}
            tone={Schemas.DashboardChipToneEnum.Warning}
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={sync.isPending}
          onClick={() => sync.mutate({ isDryRun: true })}
        >
          <MagnifyingGlass aria-hidden />
          Check changes
        </Button>
        <Button
          size="sm"
          disabled={sync.isPending}
          onClick={() => sync.mutate({ isDryRun: false })}
        >
          <ArrowsClockwise aria-hidden />
          Sync now
        </Button>
      </div>
      <Dialog open={isOpen} onOpenChange={(open) => !open && sync.reset()}>
        <DialogContent className="sm:max-w-xl">
          {sync.isPending ? (
            <ContractSyncPending isDryRun={sync.variables?.isDryRun ?? false} />
          ) : (
            isOpen && (
              <ContractSyncResult
                isDryRun={sync.variables?.isDryRun ?? false}
                response={sync.data ?? contractSyncResponse(sync.error)}
                onClose={() => sync.reset()}
              />
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ContractSyncPending({ isDryRun }: { isDryRun: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>{isDryRun ? "Checking the spec" : "Syncing the spec"}</DialogTitle>
        <DialogDescription>Reading the spec and comparing every tool's schema.</DialogDescription>
      </DialogHeader>
      <Skeleton className="h-24 rounded-xl" aria-label="Loading" />
    </div>
  );
}

// DEV_NOTE: What the spec read found: the tools whose schema changed (a dry run shows no new version yet), the ones
// left alone and why, and each one it couldn't derive. A failed read says why in the connection's words.
function ContractSyncResult({
  isDryRun,
  response,
  onClose,
}: Schemas.DashboardOperatorContractSyncResultProps) {
  const changes = response?.changes ?? [];
  const skipped = response?.skipped ?? [];
  const problems = response?.problems ?? [];
  const failure = response?.failure;
  const isClean =
    failure === undefined && changes.length === 0 && skipped.length === 0 && problems.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>
          {failure !== undefined
            ? Schemas.TOOL_CONTRACT_SYNC_FAILURE_LABEL_MAP[failure]
            : isDryRun
              ? "Checked the spec"
              : "Synced the spec"}
        </DialogTitle>
        <DialogDescription>
          {failure !== undefined
            ? "Tools keep the schemas they have. Nothing in the spec was lost."
            : isClean
              ? response?.isUnchanged
                ? "The spec hasn't changed since the last sync."
                : "Every tool already matches the spec."
              : isDryRun
                ? `${Utilities.formatCount(changes.length)} ${Utilities.plural(changes.length, "tool")} would get a new version. Nothing was written.`
                : `${Utilities.formatCount(changes.length)} ${Utilities.plural(changes.length, "tool")} got a new active version. Bot drafts that pin them now pin the new version; published versions keep theirs.`}
        </DialogDescription>
      </DialogHeader>
      {changes.length > 0 && (
        <ul
          className="flex max-h-72 flex-col gap-3 overflow-y-auto"
          aria-label="Tools that changed"
        >
          {changes.map((change) => (
            <li key={change.name} className="flex flex-col gap-1 rounded-lg border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-mono-value text-foreground">{change.name}</span>
                <span className="font-mono text-mono-value text-subtle-foreground">
                  v{change.fromVersion} → {change.toVersion ? `v${change.toVersion}` : "next"}
                </span>
                <StatusChip
                  label={Schemas.TOOL_SCHEMA_CHANGE_LABEL_MAP[change.change]}
                  tone={CHANGE_TONE[change.change]}
                />
              </div>
              {change.notes.length > 0 && (
                <ul className="list-disc pl-5 text-caption text-muted-foreground">
                  {change.notes.map((note) => (
                    <li key={note} className="font-mono">
                      {note}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <p className="text-body text-muted-foreground">
          Left alone, a draft is being edited or the tool is on another connection:{" "}
          <span className="font-mono text-mono-value">{skipped.join(", ")}</span>
        </p>
      )}
      {problems.length > 0 && (
        <ul className="flex flex-col gap-1 text-body text-foreground" aria-label="Not synced">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

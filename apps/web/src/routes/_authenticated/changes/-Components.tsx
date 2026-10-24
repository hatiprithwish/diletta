import { Link } from "@tanstack/react-router";
import type * as Schemas from "@app/schemas";
import { Card } from "@app/ui/components/card";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";

// DEV_NOTE: One change's detail card (M4-4): what it was, where it stands and the conversation it came from. Never its
// values. M4-5 adds the timeline and resolve.
export function ChangeDetail({ changeRequest }: Schemas.DashboardChangeDetailProps) {
  const { conversation } = changeRequest;
  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-start justify-between gap-3 px-[22px] pt-5 pb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-section break-words text-foreground">{changeRequest.summary}</h2>
          {changeRequest.wasEdited && (
            <p className="text-caption text-muted-foreground">Edited by the user before approval</p>
          )}
        </div>
        <StatusChip
          label={changeRequest.changeRequestStatusLabel}
          tone={Utilities.changeRequestTone(changeRequest.changeRequestStatus)}
        />
      </div>
      {changeRequest.errorLabel && (
        <p className="mx-[22px] mb-4 rounded-lg bg-destructive-soft px-3 py-2.5 text-body text-foreground">
          {changeRequest.errorLabel}
        </p>
      )}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 border-t px-[22px] py-4 text-body">
        <dt className="text-muted-foreground">Tool</dt>
        <dd className="font-mono text-mono-value text-foreground">
          {changeRequest.toolName ?? "Removed tool"} v{changeRequest.toolVersion}
        </dd>
        <dt className="text-muted-foreground">Records</dt>
        <dd className="text-foreground">{Utilities.formatCount(changeRequest.changeCount)}</dd>
        <dt className="text-muted-foreground">Proposed</dt>
        <dd className="text-foreground">{Utilities.formatWhenWithTime(changeRequest.createdAt)}</dd>
        <dt className="text-muted-foreground">Last update</dt>
        <dd className="text-foreground">{Utilities.formatWhenWithTime(changeRequest.updatedAt)}</dd>
        {changeRequest.undoUntil !== null && (
          <>
            <dt className="text-muted-foreground">Undo until</dt>
            <dd className="text-foreground">
              {Utilities.formatWhenWithTime(changeRequest.undoUntil)}
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-col gap-1 border-t px-[22px] py-4">
        <p className="text-caption text-muted-foreground">From the conversation</p>
        <Link
          to="/conversations/$id"
          params={{ id: conversation.publicId }}
          className="text-body break-words text-brand-text hover:text-foreground"
        >
          {conversation.title ?? "Open conversation"}
        </Link>
        <p className="text-caption text-muted-foreground">
          {[conversation.userName ?? "Unnamed user", conversation.chatbotName]
            .filter((part): part is string => part !== null)
            .join(", ")}
        </p>
      </div>
    </Card>
  );
}

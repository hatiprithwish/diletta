import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { Skeleton } from "@app/ui/components/skeleton";
import { ApiError } from "@/providers/apiClient";
import { useChange } from "../-data";
import { ChangeDetail } from "../-Components";

// DEV_NOTE: One change (M4-4, opened from a conversation's tool row); M4-5 puts the list next to it
export const Route = createFileRoute("/_authenticated/changes/$id/")({
  component: ChangePage,
});

function ChangePage() {
  const { id } = Route.useParams();
  const query = useChange(id);
  const changeRequest = query.data?.changeRequest;
  const isNotFound = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Changes"
        description="Writes the assistant proposed, with approvals and checks"
      />
      <div className="grid gap-6 min-[1100px]:grid-cols-3">
        <div className="min-w-0 min-[1100px]:col-span-2">
          {query.isPending && (
            <Skeleton className="h-64 rounded-xl" aria-busy="true" aria-label="Loading" />
          )}
          {!query.isPending && !changeRequest && isNotFound && (
            <p className="rounded-xl border px-[22px] py-5 text-body text-muted-foreground">
              This change isn't available. It may have been removed.
            </p>
          )}
          {!query.isPending && !changeRequest && !isNotFound && (
            <PageError title="The change didn't load" onRetry={() => void query.refetch()} />
          )}
          {changeRequest && <ChangeDetail changeRequest={changeRequest} />}
        </div>
      </div>
    </div>
  );
}

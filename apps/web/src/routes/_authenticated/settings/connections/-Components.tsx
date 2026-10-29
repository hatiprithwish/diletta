import { useState } from "react";
import type { PropsWithChildren } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Skeleton } from "@app/ui/components/skeleton";
import { OriginsDialog } from "@/components/origins-dialog";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import { useUpdateAllowedOrigins } from "../../-originsMutation";
import { useConnections } from "./-data";

// DEV_NOTE: The whole /settings/connections body (DESIGN.md dashboard-Connections): how the assistant reaches the host,
// one card per connection, production first. Only the allowed origins are edited here; the address, sign-in method and
// issuer are set up with the Diletta contact. Test user and Clean-up after tests come with test runs (M5-2).
export function ConnectionsPage() {
  const query = useConnections();
  const connections = query.data?.connections;

  return (
    <div className="flex flex-col gap-10">
      <PageHeader title="Connections" description="How the assistant reaches your app" />
      <section className="flex flex-col gap-4" aria-label="Connections">
        <SectionHeader
          title="Connections"
          description="How the assistant reaches your app. Test runs use the staging connection only."
        />
        {query.isPending && <Skeleton className="h-48 rounded-xl" aria-label="Loading" />}
        {!query.isPending && !connections && (
          <PageError title="Connections didn't load" onRetry={() => void query.refetch()} />
        )}
        {connections && connections.length === 0 && (
          <div className="rounded-xl border px-[22px] py-5">
            <p className="text-body text-muted-foreground">
              No connection yet. Your Diletta contact sets it up with your app's address and sign-in
              details.
            </p>
          </div>
        )}
        {connections?.map((connection) => (
          <ConnectionCard key={connection.publicId} connection={connection} />
        ))}
      </section>
    </div>
  );
}

function ConnectionRow({ label, children }: PropsWithChildren<Schemas.DashboardSettingsRowProps>) {
  return (
    <div className="flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:gap-6">
      <dt className="w-40 shrink-0 text-body text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  );
}

function ConnectionCard({ connection }: Schemas.DashboardSettingsConnectionCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const update = useUpdateAllowedOrigins(connection.publicId);
  const isStaging = connection.environment === Schemas.CompanyConnectionEnvironmentIntEnum.Staging;

  return (
    <div
      className="flex flex-col rounded-xl border px-[22px] py-2"
      aria-label={`${connection.environmentLabel} connection`}
      role="group"
    >
      <div className="flex items-center justify-between gap-3 border-b py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-body font-medium text-foreground">{connection.environmentLabel}</h3>
          {connection.status !== Schemas.CompanyConnectionStatusIntEnum.Active && (
            <StatusChip
              label={connection.statusLabel}
              tone={Schemas.DashboardChipToneEnum.Neutral}
            />
          )}
        </div>
        <Button
          variant="outline"
          onClick={() => setIsEditing(true)}
          aria-label={`Edit ${connection.environmentLabel} origins`}
        >
          <PencilSimple aria-hidden />
          Edit origins
        </Button>
      </div>
      <dl>
        <ConnectionRow label="API address">
          {connection.baseUrl ? (
            <span className="font-mono text-mono-value break-all">{connection.baseUrl}</span>
          ) : (
            <span className="text-muted-foreground">Not set up yet</span>
          )}
        </ConnectionRow>
        <ConnectionRow label="Sign-in">{connection.signInLabel}</ConnectionRow>
        <ConnectionRow label="JWT issuer">
          <span className="font-mono text-mono-value break-all">{connection.jwtIssuer}</span>
        </ConnectionRow>
        <ConnectionRow label="Allowed origins">
          <ul className="flex flex-wrap gap-2" aria-label="Allowed origins">
            {connection.allowedOrigins.map((origin) => (
              <li
                key={origin}
                className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-mono-value text-subtle-foreground"
              >
                {origin.replace(/^https:\/\//, "")}
              </li>
            ))}
          </ul>
        </ConnectionRow>
        {isStaging && (
          <ConnectionRow label="Used by">Test runs only, never your live users.</ConnectionRow>
        )}
      </dl>
      <OriginsDialog
        connection={connection}
        isOpen={isEditing}
        onClose={() => setIsEditing(false)}
        onSave={(allowedOrigins) => update.mutateAsync({ allowedOrigins })}
      />
    </div>
  );
}

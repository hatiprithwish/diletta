import type { PropsWithChildren } from "react";
import type { ZodType } from "zod";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { PencilSimple, Plus } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@app/ui/components/select";
import { Skeleton } from "@app/ui/components/skeleton";
import { Switch } from "@app/ui/components/switch";
import { Textarea } from "@app/ui/components/textarea";
import { PageHeader } from "@/components/page-header";
import { PageError } from "@/components/page-state";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import {
  connectionFailure,
  useCompanyConnection,
  useCompanyConnections,
  useCreateConnection,
  useOperatorCompany,
  useUpdateConnection,
} from "./-data";

const { Production, Staging } = Schemas.CompanyConnectionEnvironmentIntEnum;

const ENVIRONMENT_TONE: Record<
  Schemas.CompanyConnectionEnvironmentIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Production]: Schemas.DashboardChipToneEnum.Success,
  [Staging]: Schemas.DashboardChipToneEnum.Neutral,
};

// DEV_NOTE: The sign-in methods the platform can run (an AuthStrategy exists); any other is refused by the API
const SIGN_IN_OPTIONS = Object.keys(
  Schemas.SUPPORTED_AUTH_TYPES,
) as Schemas.CompanyConnectionAuthTypeEnum[];

// ─── Connections section

// DEV_NOTE: A company's Connections section (M7-8 design, Company › Connections): one card per connection, production
// first, and Add connection
export function ConnectionsSection({ company }: Schemas.DashboardOperatorCompanySectionProps) {
  const query = useCompanyConnections(company.publicId);
  const connections = query.data?.companyConnections
    ?.slice()
    .sort((a, b) => a.environment - b.environment);

  return (
    <section className="flex flex-col gap-4" aria-label="Connections">
      <SectionHeader
        title="Connections"
        description={`How the assistant reaches ${company.name}. Test runs use the staging connection only.`}
      >
        <Button asChild>
          <Link to="/operator/companies/$id/connections/new" params={{ id: company.publicId }}>
            <Plus aria-hidden />
            Add connection
          </Link>
        </Button>
      </SectionHeader>
      {query.isPending && <Skeleton className="h-48 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !connections && (
        <PageError title="Connections didn't load" onRetry={() => void query.refetch()} />
      )}
      {connections && connections.length === 0 && (
        <div className="rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            No connection yet. Add the staging one first: test runs and the tools use it.
          </p>
        </div>
      )}
      {connections?.map((connection) => (
        <ConnectionCard
          key={connection.publicId}
          companyPublicId={company.publicId}
          connection={connection}
        />
      ))}
    </section>
  );
}

function ConnectionRow({ label, children }: PropsWithChildren<Schemas.DashboardSettingsRowProps>) {
  return (
    <div className="flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:gap-6">
      <dt className="w-44 shrink-0 text-body text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  );
}

// DEV_NOTE: reset_op is stored as JSON; shown as its method and path
function resetOpLabel(resetOp: unknown): string | null {
  const parsed = Schemas.ZConnectionResetOp.safeParse(resetOp);
  return parsed.success ? `${parsed.data.method} ${parsed.data.path}` : null;
}

function ConnectionCard({
  companyPublicId,
  connection,
}: Schemas.DashboardOperatorConnectionCardProps) {
  const isActive =
    connection.companyConnectionStatus === Schemas.CompanyConnectionStatusIntEnum.Active;
  const resetOp = resetOpLabel(connection.resetOp);

  return (
    <div
      className="flex flex-col rounded-xl border px-[22px] py-2"
      role="group"
      aria-label={`${connection.companyConnectionEnvironmentLabel} connection`}
    >
      <div className="flex items-center justify-between gap-3 border-b py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip
            label={connection.companyConnectionEnvironmentLabel}
            tone={ENVIRONMENT_TONE[connection.companyConnectionEnvironment]}
          />
          {!isActive && (
            <StatusChip
              label={connection.companyConnectionStatusLabel}
              tone={Schemas.DashboardChipToneEnum.Warning}
            />
          )}
        </div>
        <Button variant="outline" asChild>
          <Link
            to="/operator/companies/$id/connections/$connectionId"
            params={{ id: companyPublicId, connectionId: connection.publicId }}
            aria-label={`Edit ${connection.companyConnectionEnvironmentLabel} connection`}
          >
            <PencilSimple aria-hidden />
            Edit
          </Link>
        </Button>
      </div>
      <dl>
        <ConnectionRow label="API address">
          {connection.baseUrl ? (
            <span className="font-mono text-mono-value break-all">{connection.baseUrl}</span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </ConnectionRow>
        <ConnectionRow label="Sign-in">
          {Schemas.companyConnectionSignInLabel(connection.authType)}
        </ConnectionRow>
        <ConnectionRow label="JWT issuer">
          <span className="font-mono text-mono-value break-all">{connection.jwtIssuer}</span>
        </ConnectionRow>
        <ConnectionRow label="Allowed origins">
          {connection.allowedOrigins.length > 0 ? (
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
          ) : (
            <span className="text-muted-foreground">None: the widget opens nowhere yet</span>
          )}
        </ConnectionRow>
        {connection.companyConnectionEnvironment === Staging && (
          <ConnectionRow label="Clean-up after tests">
            {resetOp ? (
              <span className="font-mono text-mono-value">{resetOp}</span>
            ) : (
              <span className="text-muted-foreground">
                None. Test cases must not depend on earlier data.
              </span>
            )}
          </ConnectionRow>
        )}
      </dl>
    </div>
  );
}

// ─── Add / edit a connection

// DEV_NOTE: /operator/companies/$id/connections/new and …/$connectionId: the company's name in the header, then the
// form once the connection (when editing) has loaded
export function ConnectionPage({
  companyPublicId,
  connectionPublicId,
}: Schemas.DashboardOperatorConnectionPageProps) {
  const companyQuery = useOperatorCompany(companyPublicId);
  const connectionQuery = useCompanyConnection(companyPublicId, connectionPublicId);
  const company = companyQuery.data?.company;
  const connection = connectionQuery.data?.companyConnection ?? null;
  const isEditing = connectionPublicId !== null;

  if (companyQuery.isPending || (isEditing && connectionQuery.isPending)) {
    return <Skeleton className="h-96 rounded-xl" aria-label="Loading" />;
  }
  if (!company || (isEditing && !connection)) {
    return (
      <PageError
        title="This connection didn't load"
        onRetry={() => {
          void companyQuery.refetch();
          if (isEditing) void connectionQuery.refetch();
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-9">
      <PageHeader
        title={
          connection
            ? `${connection.companyConnectionEnvironmentLabel} connection`
            : "Add a connection"
        }
        description={`How the assistant reaches ${company.name}'s API.`}
      />
      <ConnectionForm companyPublicId={companyPublicId} connection={connection} />
    </div>
  );
}

// DEV_NOTE: Field checks, with the API's own schemas, before anything is sent
function schemaIssue(schema: ZodType, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success ? undefined : (parsed.error.issues[0]?.message ?? "Invalid value");
}

function parseJson(text: string): { isValid: true; value: unknown } | { isValid: false } {
  try {
    return { isValid: true, value: JSON.parse(text) as unknown };
  } catch {
    return { isValid: false };
  }
}

function authConfigIssue(
  text: string,
  authType: string,
  credentialScope: Schemas.CompanyConnectionCredentialScopeIntEnum,
) {
  const parsed = parseJson(text);
  if (!parsed.isValid) return "Must be JSON";
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return "Must be a JSON object";
  }
  return (
    Schemas.getAuthConfigIssue({ authType, credentialScope, authConfig: parsed.value }) ?? undefined
  );
}

function toOrigins(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function originsIssue(text: string) {
  for (const origin of toOrigins(text)) {
    const issue = schemaIssue(Schemas.ZOrigin, origin);
    if (issue) return `${origin}: ${issue}`;
  }
  return undefined;
}

function resetOpIssue(text: string) {
  const parsed = parseJson(text);
  if (!parsed.isValid) return "Must be JSON";
  return schemaIssue(Schemas.ZConnectionResetOp, parsed.value);
}

function credentialScopeFor(authType: Schemas.CompanyConnectionAuthTypeEnum) {
  return (
    Schemas.SUPPORTED_AUTH_TYPES[authType]?.credentialScopes[0] ??
    Schemas.CompanyConnectionCredentialScopeIntEnum.None
  );
}

// DEV_NOTE: Add (connection null) or edit. Environment, type, sign-in method and credentials are fixed once created
// (tools and secrets are bound to them), so editing shows them read-only. A clean-up call exists on Staging only.
// Awaits the write (mutateAsync) and goes back to the company's Connections; a taken issuer is shown on its field.
function ConnectionForm({
  companyPublicId,
  connection,
}: Schemas.DashboardOperatorConnectionFormProps) {
  const navigate = useNavigate();
  const create = useCreateConnection(companyPublicId);
  const update = useUpdateConnection(companyPublicId, connection?.publicId ?? "");
  const form = useForm({
    defaultValues: {
      environment: String(connection?.companyConnectionEnvironment ?? Staging),
      authType: (connection?.authType ??
        SIGN_IN_OPTIONS[0] ??
        Schemas.CompanyConnectionAuthTypeEnum.JwtForward) as Schemas.CompanyConnectionAuthTypeEnum,
      baseUrl: connection?.baseUrl ?? "",
      jwtIssuer: connection?.jwtIssuer ?? "",
      authConfig: JSON.stringify(connection?.authConfig ?? {}, null, 2),
      origins: connection?.allowedOrigins.join("\n") ?? "",
      hasResetOp: connection?.resetOp !== null && connection?.resetOp !== undefined,
      resetOp: connection?.resetOp
        ? JSON.stringify(connection.resetOp, null, 2)
        : '{\n  "method": "POST",\n  "path": "/"\n}',
      isActive:
        (connection?.companyConnectionStatus ?? Schemas.CompanyConnectionStatusIntEnum.Active) ===
        Schemas.CompanyConnectionStatusIntEnum.Active,
    },
    onSubmit: async ({ value }) => {
      const isStaging = Number(value.environment) === Staging;
      const resetOp =
        isStaging && value.hasResetOp
          ? Schemas.ZConnectionResetOp.parse(JSON.parse(value.resetOp))
          : null;
      const authConfig = JSON.parse(
        value.authConfig,
      ) as Schemas.CreateCompanyConnectionApiRequest["companyConnection"]["authConfig"];
      try {
        if (connection) {
          await update.mutateAsync({
            companyConnection: {
              baseUrl: value.baseUrl,
              jwtIssuer: value.jwtIssuer,
              authConfig,
              allowedOrigins: toOrigins(value.origins),
              status: value.isActive
                ? Schemas.CompanyConnectionStatusIntEnum.Active
                : Schemas.CompanyConnectionStatusIntEnum.Disabled,
              ...(isStaging ? { resetOp } : {}),
            },
          });
        } else {
          await create.mutateAsync({
            companyConnection: {
              environment: Number(value.environment) as Schemas.CompanyConnectionEnvironmentIntEnum,
              adapterType: Schemas.CompanyConnectionAdapterTypeIntEnum.Rest,
              baseUrl: value.baseUrl,
              authType: value.authType,
              authConfig,
              credentialScope: credentialScopeFor(value.authType),
              jwtIssuer: value.jwtIssuer,
              allowedOrigins: toOrigins(value.origins),
              resetOp,
            },
          });
        }
      } catch (error) {
        if (connectionFailure(error) === Schemas.CompanyConnectionFailureEnum.IssuerTaken) {
          form.setFieldMeta("jwtIssuer", (meta) => ({
            ...meta,
            errorMap: { ...meta.errorMap, onChange: "Another connection already uses this issuer" },
          }));
        }
        throw error;
      }
      void navigate({ to: "/operator/companies/$id", params: { id: companyPublicId } });
    },
  });

  return (
    <form
      className="flex flex-col gap-9"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().catch(() => undefined);
      }}
    >
      {connection ? (
        <section
          className="flex flex-col gap-3 rounded-xl border px-[22px] py-5"
          aria-label="Set when created"
        >
          <SectionHeader
            title="Set when created"
            description="Tools and secrets depend on these. To change one, add a new connection."
          />
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Environment", connection.companyConnectionEnvironmentLabel],
              ["Type", connection.companyConnectionAdapterTypeLabel],
              ["Sign-in", Schemas.companyConnectionSignInLabel(connection.authType)],
              ["Stored credentials", connection.companyConnectionCredentialScopeLabel],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="text-caption text-muted-foreground">{label}</dt>
                <dd className="text-body text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <section className="flex flex-col gap-5" aria-label="Kind of connection">
          <SectionHeader
            title="Kind of connection"
            description="These can't change later: tools and secrets depend on them."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <form.Field name="environment">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="connection-environment">Environment</FieldLabel>
                  <Select value={field.state.value} onValueChange={field.handleChange}>
                    <SelectTrigger id="connection-environment" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[Staging, Production].map((environment) => (
                        <SelectItem key={environment} value={String(environment)}>
                          {Schemas.COMPANY_CONNECTION_ENVIRONMENT_LABEL_MAP[environment]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </form.Field>
            <form.Field name="authType">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="connection-sign-in">Sign-in</FieldLabel>
                  <Select
                    value={field.state.value}
                    onValueChange={(value) =>
                      field.handleChange(value as Schemas.CompanyConnectionAuthTypeEnum)
                    }
                  >
                    <SelectTrigger id="connection-sign-in" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SIGN_IN_OPTIONS.map((authType) => (
                        <SelectItem key={authType} value={authType}>
                          {Schemas.companyConnectionSignInLabel(authType)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Only the methods the platform can run are listed.
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-5" aria-label="Address and sign-in">
        <SectionHeader title="Address and sign-in" />
        <form.Field
          name="baseUrl"
          validators={{
            onChange: ({ value }) =>
              schemaIssue(Schemas.ZCompanyConnectionBase.shape.baseUrl, value),
          }}
        >
          {(field) => (
            <Field data-invalid={field.state.meta.errors.length > 0}>
              <FieldLabel htmlFor="connection-base-url">API address</FieldLabel>
              <Input
                id="connection-base-url"
                className="font-mono text-mono-value"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="https://api.example.com/v1"
                aria-invalid={field.state.meta.errors.length > 0}
              />
              <FieldDescription>
                Every tool's path is added to this. Must be https.
              </FieldDescription>
              <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
            </Field>
          )}
        </form.Field>
        <form.Field
          name="jwtIssuer"
          validators={{
            onChange: ({ value }) =>
              schemaIssue(Schemas.ZCompanyConnectionBase.shape.jwtIssuer, value),
          }}
        >
          {(field) => (
            <Field data-invalid={field.state.meta.errors.length > 0}>
              <FieldLabel htmlFor="connection-issuer">JWT issuer</FieldLabel>
              <Input
                id="connection-issuer"
                className="font-mono text-mono-value"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="https://api.example.com"
                aria-invalid={field.state.meta.errors.length > 0}
              />
              <FieldDescription>
                Must match the iss of the tokens the app signs. Its signing keys are read from
                /.well-known/jwks.json under it.
              </FieldDescription>
              <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.authType}>
          {(authType) => (
            <form.Field
              name="authConfig"
              validators={{
                onChangeListenTo: ["authType"],
                onChange: ({ value }) =>
                  authConfigIssue(
                    value,
                    connection?.authType ?? authType,
                    connection?.companyConnectionCredentialScope ?? credentialScopeFor(authType),
                  ),
              }}
            >
              {(field) => (
                <Field data-invalid={field.state.meta.errors.length > 0}>
                  <FieldLabel htmlFor="connection-auth-config">Sign-in settings</FieldLabel>
                  <Textarea
                    id="connection-auth-config"
                    className="font-mono text-mono-value"
                    rows={3}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={field.state.meta.errors.length > 0}
                  />
                  <FieldDescription>
                    JSON. Forwarding the user's token needs none: {"{}"}
                  </FieldDescription>
                  <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
                </Field>
              )}
            </form.Field>
          )}
        </form.Subscribe>
      </section>

      <section className="flex flex-col gap-5">
        <form.Field name="origins" validators={{ onChange: ({ value }) => originsIssue(value) }}>
          {(field) => (
            <Field data-invalid={field.state.meta.errors.length > 0}>
              <FieldLabel htmlFor="connection-origins">Allowed origins</FieldLabel>
              <Textarea
                id="connection-origins"
                className="font-mono text-mono-value"
                rows={3}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="https://app.example.com"
                aria-invalid={field.state.meta.errors.length > 0}
              />
              <FieldDescription>
                One per line. The widget only opens on these sites. Exact origins, no paths.
              </FieldDescription>
              <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
            </Field>
          )}
        </form.Field>
      </section>

      <form.Subscribe
        selector={(state) => [Number(state.values.environment), state.values.hasResetOp] as const}
      >
        {([environment, hasResetOp]) =>
          environment === Staging && (
            <section className="flex flex-col gap-5" aria-label="Clean-up after tests">
              <form.Field name="hasResetOp">
                {(field) => (
                  <div className="flex items-start justify-between gap-6">
                    <div className="flex flex-col gap-0.5">
                      <label
                        htmlFor="connection-has-reset-op"
                        className="text-section text-foreground"
                      >
                        Clean-up after tests
                      </label>
                      <p className="text-caption text-muted-foreground">
                        One call that puts the staging data back after each test run, sent as the
                        test user. No placeholders.
                      </p>
                    </div>
                    <Switch
                      id="connection-has-reset-op"
                      checked={field.state.value}
                      onCheckedChange={field.handleChange}
                    />
                  </div>
                )}
              </form.Field>
              {hasResetOp && (
                <form.Field
                  name="resetOp"
                  validators={{ onChange: ({ value }) => resetOpIssue(value) }}
                >
                  {(field) => (
                    <Field data-invalid={field.state.meta.errors.length > 0}>
                      <FieldLabel htmlFor="connection-reset-op">Clean-up call</FieldLabel>
                      <Textarea
                        id="connection-reset-op"
                        className="font-mono text-mono-value"
                        rows={5}
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        aria-invalid={field.state.meta.errors.length > 0}
                      />
                      <FieldDescription>
                        JSON: method, path (under the API address), and optionally query and
                        bodyMap.
                      </FieldDescription>
                      <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
                    </Field>
                  )}
                </form.Field>
              )}
            </section>
          )
        }
      </form.Subscribe>

      {connection && (
        <form.Field name="isActive">
          {(field) => (
            <section
              className="flex items-center justify-between gap-6 rounded-xl border px-[22px] py-5"
              aria-label="Status"
            >
              <div className="flex flex-col gap-0.5">
                <label
                  htmlFor="connection-active"
                  className="text-body font-medium text-foreground"
                >
                  Active
                </label>
                <p className="text-caption text-muted-foreground">
                  Turned off, every tool on this connection stops and the widget can't sign users in
                  through it.
                </p>
              </div>
              <Switch
                id="connection-active"
                checked={field.state.value}
                onCheckedChange={field.handleChange}
              />
            </section>
          )}
        </form.Field>
      )}

      <div className="flex justify-end gap-2 border-t pt-5">
        <Button variant="outline" asChild>
          <Link to="/operator/companies/$id" params={{ id: companyPublicId }}>
            Cancel
          </Link>
        </Button>
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? "Saving…" : connection ? "Save changes" : "Add connection"}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

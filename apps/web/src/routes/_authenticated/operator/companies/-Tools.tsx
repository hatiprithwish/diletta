import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { DownloadSimple, Plus, Trash, Warning } from "@phosphor-icons/react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@app/ui/components/table";
import { Textarea } from "@app/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@app/ui/components/toggle-group";
import { cn } from "@app/ui/lib/utils";
import { toast } from "sonner";
import { PageError } from "@/components/page-state";
import { Pager, PastEndNote } from "@/components/pager";
import { SectionHeader } from "@/components/section-header";
import { StatusChip } from "@/components/status-chip";
import Utilities from "@/utils";
import {
  useCompanyConnections,
  useCompanyTool,
  useCompanyToolCount,
  useCompanyTools,
  useCreateTool,
  useCreateToolVersion,
  useDeleteTool,
  useLoadToolSet,
  useOperatorCompany,
  useSetToolStatus,
  useToolVersions,
  useUpdateTool,
} from "./-data";

const { Draft, Active, Disabled } = Schemas.ToolDefinitionStatusIntEnum;

export const TOOL_STATUS_TONE: Record<
  Schemas.ToolDefinitionStatusIntEnum,
  Schemas.DashboardChipToneEnum
> = {
  [Draft]: Schemas.DashboardChipToneEnum.Neutral,
  [Active]: Schemas.DashboardChipToneEnum.Success,
  [Disabled]: Schemas.DashboardChipToneEnum.Warning,
};

const RISK_TONE: Record<Schemas.ToolDefinitionRiskIntEnum, Schemas.DashboardChipToneEnum> = {
  [Schemas.ToolDefinitionRiskIntEnum.Read]: Schemas.DashboardChipToneEnum.Neutral,
  [Schemas.ToolDefinitionRiskIntEnum.Write]: Schemas.DashboardChipToneEnum.Warning,
  [Schemas.ToolDefinitionRiskIntEnum.Destructive]: Schemas.DashboardChipToneEnum.Destructive,
};

const STATUS_TABS: { value: Schemas.OperatorToolStatusTabEnum; label: string }[] = [
  { value: Schemas.OperatorToolStatusTabEnum.Active, label: "Active" },
  { value: Schemas.OperatorToolStatusTabEnum.Draft, label: "Draft" },
  { value: Schemas.OperatorToolStatusTabEnum.Disabled, label: "Disabled" },
  { value: Schemas.OperatorToolStatusTabEnum.All, label: "All" },
];

// DEV_NOTE: A tool names its connection by public id: shown as the connection's environment
function connectionLabel(
  connections: Schemas.CompanyConnectionWithStatus[],
  connectionPublicId: string | null,
) {
  const found = connections.find((connection) => connection.publicId === connectionPublicId);
  return found ? found.companyConnectionEnvironmentLabel : "Removed connection";
}

// DEV_NOTE: updated_at arrives as an ISO string; the shared type says Date
function updatedWhen(tool: Schemas.ToolDefinitionWithStatus) {
  return Utilities.formatWhen(new Date(tool.updatedAt).toISOString());
}

// ─── Tools section

function ToolTabCount({ companyPublicId, tab }: Schemas.DashboardOperatorToolTabCountProps) {
  const count = useCompanyToolCount(companyPublicId, Schemas.OPERATOR_TOOL_STATUS_TAB_MAP[tab]).data
    ?.totalRecords;
  if (count === undefined) return null;
  return <span className="text-muted-foreground">{Utilities.formatCount(count)}</span>;
}

// DEV_NOTE: A company's Tools section (M7-8 design, Company › Tools): every version of every tool, by name, filtered by
// status (Active first), paged; New tool. Bots pin a version, so an active one never changes: it gets a new version.
export function ToolsSection({
  company,
  search,
  onSearch,
}: Schemas.DashboardOperatorToolsSectionProps) {
  const tab = search.tools ?? Schemas.OperatorToolStatusTabEnum.Active;
  const page = search.page ?? 1;
  const status = Schemas.OPERATOR_TOOL_STATUS_TAB_MAP[tab];
  const query = useCompanyTools(company.publicId, status, page);
  const totalRecords = useCompanyToolCount(company.publicId, status).data?.totalRecords ?? null;
  const connections = useCompanyConnections(company.publicId).data?.companyConnections ?? [];
  const tools = query.data?.toolDefinitions;
  const isStale = query.isPlaceholderData;
  const [isLoadingSet, setIsLoadingSet] = useState(false);
  const goTo = (next: Pick<Schemas.OperatorCompanyPageSearch, "tools" | "page">) =>
    onSearch({ ...search, ...next });

  return (
    <section className="flex flex-col gap-4" aria-label="Tools">
      <SectionHeader
        title="Tools"
        description={`What the assistant can do in ${company.name}. Bots pin a version, so an active version never changes: start a new one.`}
      >
        <Button variant="outline" onClick={() => setIsLoadingSet(true)}>
          <DownloadSimple aria-hidden />
          Load tool set
        </Button>
        <Button asChild>
          <Link to="/operator/companies/$id/tools/new" params={{ id: company.publicId }}>
            <Plus aria-hidden />
            New tool
          </Link>
        </Button>
      </SectionHeader>
      <LoadToolSetDialog
        company={company}
        isOpen={isLoadingSet}
        onClose={() => setIsLoadingSet(false)}
      />
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={tab}
        onValueChange={(value) => {
          const next = STATUS_TABS.find((item) => item.value === value);
          if (next) {
            goTo({
              tools:
                next.value === Schemas.OperatorToolStatusTabEnum.Active ? undefined : next.value,
              page: undefined,
            });
          }
        }}
        aria-label="Show"
        className="flex-wrap self-start"
      >
        {STATUS_TABS.map((item) => (
          <ToggleGroupItem key={item.value} value={item.value} className="gap-1.5 px-3">
            {item.label}
            <ToolTabCount companyPublicId={company.publicId} tab={item.value} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {query.isPending && <Skeleton className="h-48 rounded-xl" aria-label="Loading" />}
      {!query.isPending && !tools && (
        <PageError title="Tools didn't load" onRetry={() => void query.refetch()} />
      )}
      {tools && tools.length === 0 && page === 1 && (
        <div className="rounded-xl border px-[22px] py-5">
          <p className="text-body text-muted-foreground">
            {tab === Schemas.OperatorToolStatusTabEnum.Active
              ? "No active tools yet. Create one, then make it active so bot versions can pin it."
              : "No tool versions with this status."}
          </p>
        </div>
      )}
      {tools && tools.length === 0 && page > 1 && (
        <PastEndNote
          pageSize={Schemas.OPERATOR_TOOLS_PAGE_SIZE}
          totalRecords={totalRecords}
          onPage={(next) => goTo({ page: next === 1 ? undefined : next })}
        />
      )}
      {tools && tools.length > 0 && (
        <div
          aria-busy={isStale}
          className={cn(
            "flex flex-col gap-4 transition-opacity",
            isStale && "pointer-events-none opacity-50",
          )}
        >
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4">Tool</TableHead>
                  <TableHead className="px-4">Version</TableHead>
                  <TableHead className="px-4">Status</TableHead>
                  <TableHead className="px-4">Risk</TableHead>
                  <TableHead className="px-4">Approval</TableHead>
                  <TableHead className="px-4">Connection</TableHead>
                  <TableHead className="px-4">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tools.map((tool) => (
                  <ToolRow
                    key={tool.publicId}
                    companyPublicId={company.publicId}
                    tool={tool}
                    connections={connections}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager
            page={page}
            pageSize={Schemas.OPERATOR_TOOLS_PAGE_SIZE}
            totalRecords={totalRecords}
            rowCount={tools.length}
            onPage={(next) => goTo({ page: next === 1 ? undefined : next })}
          />
        </div>
      )}
    </section>
  );
}

// ─── Load a tool set

const TOOL_SET_OPTIONS = Object.values(Schemas.ToolSetEnum).map((value) => ({
  value,
  label: Schemas.TOOL_SET_LABEL_MAP[value],
}));

// DEV_NOTE: In the order a load's summary reads them: what changed first
const TOOL_SET_CHANGES: { change: Schemas.ToolSetChangeEnum; text: string }[] = [
  { change: Schemas.ToolSetChangeEnum.Created, text: "new" },
  { change: Schemas.ToolSetChangeEnum.NewVersion, text: "new versions" },
  { change: Schemas.ToolSetChangeEnum.Reactivated, text: "made active again" },
  { change: Schemas.ToolSetChangeEnum.Unchanged, text: "unchanged" },
];

// DEV_NOTE: The form is mounted only while the dialog is open, so every opening starts fresh; after a load it shows
// what changed and the pins for a bot version
function LoadToolSetDialog({
  company,
  isOpen,
  onClose,
}: Schemas.DashboardOperatorLoadToolSetDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {isOpen && <LoadToolSetForm company={company} isOpen={isOpen} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function LoadToolSetForm({ company, onClose }: Schemas.DashboardOperatorLoadToolSetDialogProps) {
  const load = useLoadToolSet(company.publicId);
  const connectionsQuery = useCompanyConnections(company.publicId);
  const connections = (connectionsQuery.data?.companyConnections ?? []).filter(
    (connection) =>
      connection.companyConnectionStatus === Schemas.CompanyConnectionStatusIntEnum.Active,
  );
  const [loaded, setLoaded] = useState<Schemas.ToolSetTool[] | null>(null);
  const form = useForm({
    defaultValues: {
      toolSet: TOOL_SET_OPTIONS[0]!.value as string,
      connectionPublicId: connections.length === 1 ? connections[0]!.publicId : "",
    },
    onSubmit: async ({ value }) => {
      const parsed = Schemas.ZLoadToolSetApiRequest.safeParse(value);
      if (!parsed.success) return;
      const response = await load.mutateAsync(parsed.data);
      setLoaded(response.tools ?? []);
    },
  });

  if (loaded) return <ToolSetResult tools={loaded} onClose={onClose} />;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit().catch(() => undefined);
      }}
    >
      <DialogHeader>
        <DialogTitle>Load tool set</DialogTitle>
        <DialogDescription>
          Adds every tool of the set to {company.name} on one connection, active. A tool that
          changed gets a new version; bot versions keep the version they pin.
        </DialogDescription>
      </DialogHeader>
      <form.Field name="toolSet">
        {(field) => (
          <Field>
            <FieldLabel htmlFor="tool-set">Tool set</FieldLabel>
            <Select value={field.state.value} onValueChange={field.handleChange}>
              <SelectTrigger id="tool-set" className="w-full">
                <SelectValue placeholder="Choose one" />
              </SelectTrigger>
              <SelectContent>
                {TOOL_SET_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field
        name="connectionPublicId"
        validators={{ onChange: ({ value }) => (value ? undefined : "Choose a connection.") }}
      >
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor="tool-set-connection">Connection</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={field.handleChange}
              disabled={connections.length === 0}
            >
              <SelectTrigger id="tool-set-connection" className="w-full">
                <SelectValue
                  placeholder={
                    connectionsQuery.isPending
                      ? "Loading…"
                      : connections.length === 0
                        ? "No active connection"
                        : "Choose one"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {connections.map((connection) => (
                  <SelectItem key={connection.publicId} value={connection.publicId}>
                    {connection.companyConnectionEnvironmentLabel} · {connection.baseUrl}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              The tools call this connection&apos;s API address. Only active connections are listed.
            </FieldDescription>
            <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
          </Field>
        )}
      </form.Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <form.Subscribe
          selector={(state) =>
            [state.canSubmit, state.isSubmitting, state.values.connectionPublicId] as const
          }
        >
          {([canSubmit, isSubmitting, connectionPublicId]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting || !connectionPublicId}>
              {isSubmitting ? "Loading…" : "Load tools"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}

// DEV_NOTE: What a load did, by change, and the {name, version} pins to put in a bot version's tools
function ToolSetResult({ tools, onClose }: Schemas.DashboardOperatorToolSetResultProps) {
  const pins = JSON.stringify(
    tools.map(({ name, version }) => ({ name, version })),
    null,
    2,
  );
  const summary = TOOL_SET_CHANGES.map(({ change, text }) => {
    const count = tools.filter((tool) => tool.change === change).length;
    return count > 0 ? `${Utilities.formatCount(count)} ${text}` : null;
  })
    .filter((part) => part !== null)
    .join(", ");

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Tools loaded</DialogTitle>
        <DialogDescription>
          {Utilities.formatCount(tools.length)} tools: {summary}. Pin the ones a bot needs in its
          draft version; every pinned tool goes into every model call.
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="tool-set-pins">Pins</FieldLabel>
        <Textarea
          id="tool-set-pins"
          readOnly
          value={pins}
          className="h-56 font-mono text-mono-value"
        />
      </Field>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(pins).then(
              () => toast.success("Pins copied."),
              () => toast.error("Couldn't copy. Select the pins and copy them instead."),
            );
          }}
        >
          Copy pins
        </Button>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

function ToolRow({ companyPublicId, tool, connections }: Schemas.DashboardOperatorToolRowProps) {
  return (
    <TableRow>
      <TableCell className="px-4 py-3">
        <Link
          to="/operator/companies/$id/tools/$toolId"
          params={{ id: companyPublicId, toolId: tool.publicId }}
          className="font-mono text-mono-value text-foreground hover:underline"
        >
          {tool.name}
        </Link>
      </TableCell>
      <TableCell className="px-4 py-3 font-mono text-mono-value text-subtle-foreground">
        v{tool.version}
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip
          label={tool.toolDefinitionStatusLabel}
          tone={TOOL_STATUS_TONE[tool.toolDefinitionStatus]}
        />
      </TableCell>
      <TableCell className="px-4 py-3">
        <StatusChip label={tool.riskLabel} tone={RISK_TONE[tool.risk]} />
      </TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">{tool.approvalLabel}</TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">
        {connectionLabel(connections, tool.connectionPublicId)}
      </TableCell>
      <TableCell className="px-4 py-3 text-subtle-foreground">{updatedWhen(tool)}</TableCell>
    </TableRow>
  );
}

// ─── One tool version

// DEV_NOTE: /operator/companies/$id/tools/new and …/tools/$toolId: the version's form, its actions and its other
// versions, once the company, its connections and (when open) the version have loaded
export function ToolPage({
  companyPublicId,
  toolPublicId,
}: Schemas.DashboardOperatorToolPageProps) {
  const companyQuery = useOperatorCompany(companyPublicId);
  const connectionsQuery = useCompanyConnections(companyPublicId);
  const toolQuery = useCompanyTool(companyPublicId, toolPublicId);
  const isOpen = toolPublicId !== null;
  const tool = toolQuery.data?.toolDefinition ?? null;
  const connections = connectionsQuery.data?.companyConnections;

  if (companyQuery.isPending || connectionsQuery.isPending || (isOpen && toolQuery.isPending)) {
    return <Skeleton className="h-96 rounded-xl" aria-label="Loading" />;
  }
  if (!companyQuery.data?.company || !connections || (isOpen && !tool)) {
    return (
      <PageError
        title="This tool didn't load"
        onRetry={() => {
          void companyQuery.refetch();
          void connectionsQuery.refetch();
          if (isOpen) void toolQuery.refetch();
        }}
      />
    );
  }

  // DEV_NOTE: Keyed by the version, so opening another one (Versions, New version) starts its form afresh
  return (
    <ToolForm
      key={tool?.publicId ?? "new"}
      companyPublicId={companyPublicId}
      tool={tool}
      connections={connections}
    />
  );
}

function toJsonText(value: unknown) {
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
}

function jsonIssue(text: string, isOptional: boolean) {
  if (isOptional && text.trim() === "") return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch {
    return "Must be JSON";
  }
}

const OP_LABELS: Record<keyof Schemas.ToolOps, string> = {
  inputSchema: "Input",
  callOp: "Call",
  readbackOp: "Read back",
  inverseOp: "Undo",
};

// DEV_NOTE: The whole version as the API would check it: the ops' shape and placeholders (ZToolOps), then the risk rule
// and an input schema the runtime can check (getToolOpsIssue). Either the request body's fields or the first reason.
function checkTool(
  values: Schemas.DashboardOperatorToolFormValues,
): Schemas.DashboardOperatorToolCheck {
  const parsed: Record<string, unknown> = {};
  for (const key of ["inputSchema", "callOp", "readbackOp", "inverseOp"] as const) {
    const text = values[key];
    if (key !== "inputSchema" && key !== "callOp" && text.trim() === "") {
      parsed[key] = null;
      continue;
    }
    try {
      parsed[key] = JSON.parse(text);
    } catch {
      return { isValid: false, issue: `${OP_LABELS[key]} must be JSON` };
    }
  }
  const ops = Schemas.ZToolOps.safeParse(parsed);
  if (!ops.success) {
    const first = ops.error.issues[0];
    const key = first?.path[0] as keyof Schemas.ToolOps | undefined;
    const where = key && key in OP_LABELS ? `${OP_LABELS[key]}: ` : "";
    return { isValid: false, issue: `${where}${first?.message ?? "The calls aren't valid"}` };
  }
  const risk = Number(values.risk) as Schemas.ToolDefinitionRiskIntEnum;
  const idempotencyMode = Number(
    values.idempotencyMode,
  ) as Schemas.ToolDefinitionIdempotencyModeIntEnum;
  const issue = Schemas.getToolOpsIssue(risk, idempotencyMode, ops.data);
  return issue
    ? { isValid: false, issue }
    : { isValid: true, risk, idempotencyMode, ops: ops.data };
}

function enumOptions<T extends number>(labels: Record<T, string>) {
  return (Object.entries(labels) as [string, string][]).map(([value, label]) => ({ value, label }));
}

const RISK_OPTIONS = enumOptions(Schemas.TOOL_DEFINITION_RISK_LABEL_MAP);
const APPROVAL_OPTIONS = enumOptions(Schemas.TOOL_DEFINITION_APPROVAL_LABEL_MAP);
const IDEMPOTENCY_OPTIONS = enumOptions(Schemas.TOOL_DEFINITION_IDEMPOTENCY_MODE_LABEL_MAP);

// DEV_NOTE: A new tool (tool null) or one version. Only a Draft is edited; an active or disabled version shows read-only
// (a bot version may pin it) with Disable / Make active and New version. The checks the API runs show above the calls
// before anything is sent.
function ToolForm({ companyPublicId, tool, connections }: Schemas.DashboardOperatorToolFormProps) {
  const navigate = useNavigate();
  const create = useCreateTool(companyPublicId);
  const update = useUpdateTool(companyPublicId, tool?.publicId ?? "");
  const isEditable = !tool || tool.toolDefinitionStatus === Draft;
  const defaultConnection =
    connections.find(
      (connection) =>
        connection.companyConnectionEnvironment ===
        Schemas.CompanyConnectionEnvironmentIntEnum.Staging,
    ) ?? connections[0];
  const form = useForm({
    defaultValues: {
      name: tool?.name ?? "",
      description: tool?.description ?? "",
      risk: String(tool?.risk ?? Schemas.ToolDefinitionRiskIntEnum.Read),
      approval: String(tool?.approval ?? Schemas.ToolDefinitionApprovalIntEnum.Always),
      idempotencyMode: String(
        tool?.idempotencyMode ?? Schemas.ToolDefinitionIdempotencyModeIntEnum.None,
      ),
      connectionPublicId: tool?.connectionPublicId ?? defaultConnection?.publicId ?? "",
      inputSchema: tool
        ? toJsonText(tool.ops.inputSchema)
        : '{\n  "type": "object",\n  "properties": {}\n}',
      callOp: tool ? toJsonText(tool.ops.callOp) : '{\n  "method": "GET",\n  "path": "/"\n}',
      readbackOp: toJsonText(tool?.ops.readbackOp),
      inverseOp: toJsonText(tool?.ops.inverseOp),
    } satisfies Schemas.DashboardOperatorToolFormValues,
    onSubmit: async ({ value }) => {
      const checked = checkTool(value);
      if (!checked.isValid) return;
      const fields = {
        connectionPublicId: value.connectionPublicId,
        description: value.description,
        risk: checked.risk,
        idempotencyMode: checked.idempotencyMode,
        approval: Number(value.approval) as Schemas.ToolDefinitionApprovalIntEnum,
        ops: checked.ops,
      };
      if (tool) {
        await update.mutateAsync({ toolDefinition: fields });
        form.reset(value);
        return;
      }
      const created = await create.mutateAsync({
        toolDefinition: {
          ...fields,
          name: value.name,
          source: Schemas.ToolDefinitionSourceIntEnum.Manual,
        },
      });
      if (created.toolDefinition) {
        void navigate({
          to: "/operator/companies/$id/tools/$toolId",
          params: { id: companyPublicId, toolId: created.toolDefinition.publicId },
        });
      }
    },
  });

  const selectField = (
    name: "risk" | "approval" | "idempotencyMode" | "connectionPublicId",
    label: string,
    options: { value: string; label: string }[],
    description?: string,
  ) => (
    <form.Field name={name}>
      {(field) => (
        <Field>
          <FieldLabel htmlFor={`tool-${name}`}>{label}</FieldLabel>
          <Select
            value={field.state.value}
            onValueChange={field.handleChange}
            disabled={!isEditable}
          >
            <SelectTrigger id={`tool-${name}`} className="w-full">
              <SelectValue placeholder="Choose one" />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && <FieldDescription>{description}</FieldDescription>}
        </Field>
      )}
    </form.Field>
  );

  const jsonField = (
    name: "inputSchema" | "callOp" | "readbackOp" | "inverseOp",
    description: string,
    rows: number,
  ) => {
    const isOptional = name === "readbackOp" || name === "inverseOp";
    return (
      <form.Field
        name={name}
        validators={{ onChange: ({ value }) => jsonIssue(value, isOptional) }}
      >
        {(field) => (
          <Field data-invalid={field.state.meta.errors.length > 0}>
            <FieldLabel htmlFor={`tool-${name}`}>{OP_LABELS[name]}</FieldLabel>
            <Textarea
              id={`tool-${name}`}
              className="bg-surface-subtle font-mono text-mono-value"
              rows={rows}
              spellCheck={false}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              readOnly={!isEditable}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            <FieldDescription>{description}</FieldDescription>
            <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
          </Field>
        )}
      </form.Field>
    );
  };

  return (
    <div className="flex flex-col gap-7">
      <form.Subscribe selector={(state) => [checkTool(state.values), state.isDirty] as const}>
        {([checked, isDirty]) => (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="font-mono text-[22px] font-medium tracking-tight text-foreground">
                    {tool ? tool.name : "New tool"}
                  </h1>
                  {tool && (
                    <>
                      <StatusChip
                        label={tool.toolDefinitionStatusLabel}
                        tone={TOOL_STATUS_TONE[tool.toolDefinitionStatus]}
                      />
                      <span className="font-mono text-mono-value text-subtle-foreground">
                        v{tool.version}
                      </span>
                    </>
                  )}
                </div>
                <p className="text-body text-muted-foreground">
                  {tool
                    ? `Updated ${updatedWhen(tool)}. ${isEditable ? "Bots keep using the active version until this one is active and a bot version pins it." : "An active or disabled version never changes: start a new version to change it."}`
                    : "It starts as a draft. Make it active once it's right; then bot versions can pin it."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {tool ? (
                  <ToolActions companyPublicId={companyPublicId} tool={tool} isDirty={isDirty} />
                ) : null}
                {isEditable && (
                  <Button
                    type="submit"
                    form="tool-form"
                    variant={tool ? "outline" : "default"}
                    disabled={!checked.isValid || create.isPending || update.isPending}
                  >
                    {tool ? "Save draft" : "Create draft"}
                  </Button>
                )}
                {tool && tool.toolDefinitionStatus === Draft && (
                  <MakeActiveButton
                    companyPublicId={companyPublicId}
                    tool={tool}
                    isDirty={isDirty || !checked.isValid}
                  />
                )}
              </div>
            </div>
            {isEditable && !checked.isValid && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-[10px] bg-destructive-soft px-4 py-3.5 text-destructive"
              >
                <Warning className="mt-0.5 shrink-0" aria-hidden />
                <div className="flex flex-col gap-0.5 text-body">
                  <span className="font-semibold">This version can't be saved yet</span>
                  <span className="text-foreground">{checked.issue}</span>
                </div>
              </div>
            )}
          </>
        )}
      </form.Subscribe>

      <div className="flex flex-wrap items-start gap-7">
        <form
          id="tool-form"
          className="flex min-w-0 flex-[999_1_560px] flex-col gap-7"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit().catch(() => undefined);
          }}
        >
          <section className="flex flex-col gap-5" aria-label="Details">
            <SectionHeader title="Details" />
            {!tool && (
              <form.Field
                name="name"
                validators={{
                  onChange: ({ value }) => {
                    const parsed = Schemas.ZToolDefinitionName.safeParse(value);
                    return parsed.success ? undefined : parsed.error.issues[0]?.message;
                  },
                }}
              >
                {(field) => (
                  <Field data-invalid={field.state.meta.errors.length > 0}>
                    <FieldLabel htmlFor="tool-name">Name</FieldLabel>
                    <Input
                      id="tool-name"
                      className="font-mono text-mono-value"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      placeholder="eregister_list_registers"
                      aria-invalid={field.state.meta.errors.length > 0}
                    />
                    <FieldDescription>
                      What the model calls it. Letters, digits, _ and -; it never changes.
                    </FieldDescription>
                    <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
                  </Field>
                )}
              </form.Field>
            )}
            <form.Field
              name="description"
              validators={{
                onChange: ({ value }) =>
                  value.trim().length === 0 ? "Say what the tool does" : undefined,
              }}
            >
              {(field) => (
                <Field data-invalid={field.state.meta.errors.length > 0}>
                  <FieldLabel htmlFor="tool-description">Description</FieldLabel>
                  <Textarea
                    id="tool-description"
                    rows={3}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    readOnly={!isEditable}
                    aria-invalid={field.state.meta.errors.length > 0}
                  />
                  <FieldDescription>
                    The model reads this to decide when to call the tool.
                  </FieldDescription>
                  <FieldError errors={Utilities.toFieldErrors(field.state.meta.errors)} />
                </Field>
              )}
            </form.Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {selectField("risk", "Risk", RISK_OPTIONS)}
              {selectField("approval", "Approval", APPROVAL_OPTIONS)}
              {selectField(
                "idempotencyMode",
                "Repeat safety",
                IDEMPOTENCY_OPTIONS,
                "How a retried write is kept from landing twice. Emulated checks by reading back.",
              )}
              {selectField(
                "connectionPublicId",
                "Connection",
                connections.map((connection) => ({
                  value: connection.publicId,
                  label: `${connection.companyConnectionEnvironmentLabel} · ${connection.baseUrl ?? "no address"}`,
                })),
              )}
            </div>
          </section>

          <section className="flex flex-col gap-5" aria-label="Calls">
            <SectionHeader
              title="Calls"
              description="JSON. Paths are under the connection's API address. Placeholders: {args.*} the model's input, {before.*} the record read before the change, {result.*} the call's response."
            />
            {jsonField("inputSchema", "JSON Schema of the arguments the model sends.", 8)}
            {jsonField("callOp", "method, path, and optionally query and bodyMap.", 6)}
            {jsonField(
              "readbackOp",
              "Writes only: a GET that proves the change landed, with compare (argument → response path). Leave empty for a read tool.",
              5,
            )}
            {jsonField(
              "inverseOp",
              "Optional: the call that puts the record back as it was. Leave empty if it can't be undone.",
              5,
            )}
          </section>
        </form>
        {tool && <ToolVersions companyPublicId={companyPublicId} tool={tool} />}
      </div>
    </div>
  );
}

// DEV_NOTE: Make active needs a saved draft that passes the checks (isDirty also covers an unsaved or invalid form)
function MakeActiveButton({
  companyPublicId,
  tool,
  isDirty,
}: Schemas.DashboardOperatorToolActionsProps) {
  const setStatus = useSetToolStatus(companyPublicId, tool.publicId);
  return (
    <Button
      disabled={isDirty || setStatus.isPending}
      title={isDirty ? "Save the draft first" : undefined}
      onClick={() => setStatus.mutate({ status: Active })}
    >
      Make active
    </Button>
  );
}

// DEV_NOTE: The version's own actions: a draft can be deleted; an active one disabled, a disabled one made active again,
// and either copied into a new draft (one draft per tool name)
function ToolActions({ companyPublicId, tool }: Schemas.DashboardOperatorToolActionsProps) {
  const navigate = useNavigate();
  const setStatus = useSetToolStatus(companyPublicId, tool.publicId);
  const newVersion = useCreateToolVersion(companyPublicId, tool.publicId);
  const [isDeleting, setIsDeleting] = useState(false);

  const startVersion = async () => {
    const created = await newVersion.mutateAsync();
    if (created.toolDefinition) {
      void navigate({
        to: "/operator/companies/$id/tools/$toolId",
        params: { id: companyPublicId, toolId: created.toolDefinition.publicId },
      });
    }
  };

  if (tool.toolDefinitionStatus === Draft) {
    return (
      <>
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setIsDeleting(true)}
        >
          <Trash aria-hidden />
          Delete draft
        </Button>
        {isDeleting && (
          <DeleteDraftDialog
            companyPublicId={companyPublicId}
            tool={tool}
            isOpen={isDeleting}
            onClose={() => setIsDeleting(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        disabled={setStatus.isPending}
        onClick={() =>
          setStatus.mutate({ status: tool.toolDefinitionStatus === Active ? Disabled : Active })
        }
      >
        {tool.toolDefinitionStatus === Active ? "Disable" : "Make active"}
      </Button>
      <Button
        disabled={newVersion.isPending}
        onClick={() => void startVersion().catch(() => undefined)}
      >
        New version
      </Button>
    </>
  );
}

function DeleteDraftDialog({
  companyPublicId,
  tool,
  isOpen,
  onClose,
}: Schemas.DashboardOperatorToolVersionsProps & Schemas.DashboardDialogProps) {
  const navigate = useNavigate();
  const remove = useDeleteTool(companyPublicId, tool.publicId);
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete draft v{tool.version}?</DialogTitle>
          <DialogDescription>
            Only this draft goes. The tool's other versions stay as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              void remove
                .mutateAsync()
                .then(() =>
                  navigate({
                    to: "/operator/companies/$id",
                    params: { id: companyPublicId },
                    search: { tab: Schemas.OperatorCompanyTabEnum.Tools },
                  }),
                )
                .catch(() => undefined)
            }
          >
            Delete draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// DEV_NOTE: Every version of this tool, newest first, the open one marked
function ToolVersions({ companyPublicId, tool }: Schemas.DashboardOperatorToolVersionsProps) {
  const query = useToolVersions(companyPublicId, tool.name);
  const versions = query.data?.toolDefinitions;

  return (
    <aside
      className="flex min-w-0 flex-[1_1_260px] flex-col gap-2 rounded-xl border px-5 py-[18px]"
      aria-label="Versions"
    >
      <h2 className="text-section text-foreground">Versions</h2>
      {query.isPending && <Skeleton className="h-24" aria-label="Loading" />}
      {!query.isPending && !versions && (
        <PageError title="Versions didn't load" onRetry={() => void query.refetch()} />
      )}
      {versions && (
        <ul className="flex flex-col">
          {versions.map((version) => (
            <li
              key={version.publicId}
              className="flex items-center justify-between gap-2 border-t py-3 text-body first:border-t-0"
            >
              {version.publicId === tool.publicId ? (
                <span className="font-mono text-mono-value text-foreground" aria-current="page">
                  v{version.version}
                </span>
              ) : (
                <Link
                  to="/operator/companies/$id/tools/$toolId"
                  params={{ id: companyPublicId, toolId: version.publicId }}
                  className="font-mono text-mono-value text-foreground underline"
                >
                  v{version.version}
                </Link>
              )}
              <StatusChip
                label={version.toolDefinitionStatusLabel}
                tone={TOOL_STATUS_TONE[version.toolDefinitionStatus]}
              />
              <span className="text-caption text-muted-foreground">{updatedWhen(version)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-muted-foreground">
        An active version never changes. To change one, start a new version from it.
      </p>
    </aside>
  );
}

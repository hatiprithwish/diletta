import {
  ToolDefinitionApprovalIntEnum,
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionRiskIntEnum,
  ToolDefinitionSourceIntEnum,
} from "../toolDefinitions/ToolDefinitionsCommon";
import { ToolOpMethodEnum } from "../toolDefinitions/ToolOpsV1";
import {
  EREGISTER_REGISTER_MODE,
  argsBodyMap,
  beforeBodyMap,
  buildEregisterInputSchema,
  compareAt,
  eregisterIdProperty,
  type EregisterToolDefinition,
} from "./EregisterCommon";
import type { EregisterInputSchemaName } from "./EregisterInputSchemas";

// DEV_NOTE: eRegister's tools (M7-2): reads, plus create / update / delete of registers, code blocks, layouts,
// actions, reports, report charts, dashboards, dashboard widgets and buttons. Stored on eRegister's connection by
// `pnpm --filter backend eregister:tools` (docs/runbooks/eregister.md). Rules, per kind:
//   Read: GET (or eRegister's POST …/list), approval Never.
//   Create: idempotency None (eRegister takes no Idempotency-Key, and an Emulated tool can't read {result.*}, which a
//     create's readback needs for the new id): an answer lost in transit is never resent and goes to a person. Read
//     back by the new id; undo deletes it.
//   Update: Emulated (a lost answer is settled by reading the record back). An update takes only the fields its
//     readback compares and its undo restores, so every field it can change is verified and undoable. Undo PUTs the
//     read-before values back.
//   Delete: destructive, idempotency None; verified by the record reading 404. Not undoable: eRegister can't recreate
//     a record under its old id.
// Compared fields are the ones eRegister returns as it stored them. Left out: a register's schema and flow (the read
// adds reference fields and fills flow defaults), an action's triggers (the read adds run state), roles access (the
// read answers another shape), a button's execution / confirmation config (renamed on read).

const READ = {
  risk: ToolDefinitionRiskIntEnum.Read,
  idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.None,
  approval: ToolDefinitionApprovalIntEnum.Never,
  source: ToolDefinitionSourceIntEnum.Manual,
} as const;

const CREATE = {
  risk: ToolDefinitionRiskIntEnum.Write,
  idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.None,
  approval: ToolDefinitionApprovalIntEnum.Always,
  source: ToolDefinitionSourceIntEnum.Manual,
} as const;

const UPDATE = {
  risk: ToolDefinitionRiskIntEnum.Write,
  idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.Emulated,
  approval: ToolDefinitionApprovalIntEnum.Always,
  source: ToolDefinitionSourceIntEnum.Manual,
} as const;

const DELETE = {
  risk: ToolDefinitionRiskIntEnum.Destructive,
  idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.None,
  approval: ToolDefinitionApprovalIntEnum.Always,
  source: ToolDefinitionSourceIntEnum.Manual,
} as const;

const PAGE_ARGS = {
  keyword: { type: "string", description: "Only names containing this", maxLength: 200 },
  pageNo: { type: "integer", description: "Page, from 1", minimum: 1 },
  pageSize: {
    type: "integer",
    description: "At most this many per page",
    minimum: 1,
    maximum: 100,
  },
};

// DEV_NOTE: One area's CRUD over eRegister. `path` is the collection, `idArg` the record id's arg name, `root` where
// eRegister puts the record in a read (and a create / update answer), `createdId` the new id's dot path in a create
// answer. A read's query (includeSource / includeContent) also goes on the readback, so a compared field is there.
interface EregisterArea {
  noun: string;
  path: string;
  pathArgs?: Record<string, Record<string, unknown>>;
  idArg: string;
  idDescription: string;
  root: string;
  idField: string;
  createdId: string;
  readQuery?: Record<string, string>;
  createBody: EregisterInputSchemaName;
  createExtra?: Record<string, Record<string, unknown>>;
  createRequired?: string[];
  createConstants?: Record<string, number | string>;
  createCompare: string[];
  updateMethod: ToolOpMethodEnum.Put;
  updateBody: EregisterInputSchemaName;
  updateFields: string[];
  // Restored by undo, when more than updateFields (a full-replace PUT sends the whole record back)
  undoFields?: string[];
  updateCompare: string[];
  renamed?: Record<string, string>;
  createDescription: string;
  updateDescription: string;
  deleteDescription: string;
}

function areaTools(area: EregisterArea): EregisterToolDefinition[] {
  const record = `${area.path}/{args.${area.idArg}}`;
  const pathArgs = { ...area.pathArgs, [area.idArg]: eregisterIdProperty(area.idDescription) };
  const createdPath = `${area.path}/{result.${area.createdId}}`;
  const readQuery = area.readQuery ? { query: area.readQuery } : {};
  const updateFields = area.updateFields;

  return [
    {
      name: `eregister_get_${area.noun}`,
      description: `Read one ${area.noun.replace(/_/g, " ")} by id.`,
      ...READ,
      ops: {
        inputSchema: buildEregisterInputSchema({ pathArgs }),
        callOp: { method: ToolOpMethodEnum.Get, path: record, ...readQuery },
        readbackOp: null,
        inverseOp: null,
      },
    },
    {
      name: `eregister_create_${area.noun}`,
      description: area.createDescription,
      ...CREATE,
      ops: {
        inputSchema: buildEregisterInputSchema({
          pathArgs: area.pathArgs,
          body: area.createBody,
          extra: area.createExtra,
          required: area.createRequired,
        }),
        callOp: {
          method: ToolOpMethodEnum.Post,
          path: area.path,
          bodyMap: {
            ...area.createConstants,
            ...argsBodyMap([...Object.keys(area.createExtra ?? {}), ...bodyNames(area.createBody)]),
          },
        },
        readbackOp: {
          method: ToolOpMethodEnum.Get,
          path: createdPath,
          ...readQuery,
          compare: compareAt(area.root, area.createCompare, area.renamed),
        },
        inverseOp: { method: ToolOpMethodEnum.Delete, path: createdPath },
      },
    },
    {
      name: `eregister_update_${area.noun}`,
      description: area.updateDescription,
      ...UPDATE,
      ops: {
        inputSchema: buildEregisterInputSchema({
          pathArgs,
          body: area.updateBody,
          pick: updateFields,
        }),
        callOp: { method: area.updateMethod, path: record, bodyMap: argsBodyMap(updateFields) },
        readbackOp: {
          method: ToolOpMethodEnum.Get,
          path: record,
          ...readQuery,
          compare: compareAt(area.root, area.updateCompare, area.renamed),
        },
        inverseOp: {
          method: area.updateMethod,
          path: record,
          bodyMap: beforeBodyMap(area.root, area.undoFields ?? updateFields),
        },
      },
    },
    {
      name: `eregister_delete_${area.noun}`,
      description: `${area.deleteDescription} This can't be undone.`,
      ...DELETE,
      ops: {
        inputSchema: buildEregisterInputSchema({ pathArgs }),
        callOp: { method: ToolOpMethodEnum.Delete, path: record },
        readbackOp: {
          method: ToolOpMethodEnum.Get,
          path: record,
          compare: { [area.idArg]: `${area.root}.${area.idField}` },
        },
        inverseOp: null,
      },
    },
  ];
}

function bodyNames(body: EregisterInputSchemaName): string[] {
  return Object.keys(
    buildEregisterInputSchema({ body }).properties as Record<string, unknown>,
  ).filter((name) => name !== "companyId");
}

function listTool(params: {
  name: string;
  description: string;
  method: ToolOpMethodEnum.Get | ToolOpMethodEnum.Post;
  path: string;
  pathArgs?: Record<string, Record<string, unknown>>;
  args?: Record<string, Record<string, unknown>>;
  required?: string[];
}): EregisterToolDefinition {
  const argNames = Object.keys(params.args ?? {});
  return {
    name: params.name,
    description: params.description,
    ...READ,
    ops: {
      inputSchema: buildEregisterInputSchema({
        pathArgs: params.pathArgs,
        extra: params.args,
        required: params.required,
      }),
      callOp:
        params.method === ToolOpMethodEnum.Post
          ? { method: params.method, path: params.path, bodyMap: argsBodyMap(argNames) }
          : {
              method: params.method,
              path: params.path,
              ...(argNames.length
                ? { query: Object.fromEntries(argNames.map((n) => [n, `{args.${n}}`])) }
                : {}),
            },
      readbackOp: null,
      inverseOp: null,
    },
  };
}

const COMPANY = "/companies/{args.companyId}";
const REGISTERS = `${COMPANY}/${EREGISTER_REGISTER_MODE}/registers`;
const REPORT_ID = { reportId: eregisterIdProperty("The report's id") };

const AREAS: EregisterArea[] = [
  {
    noun: "register",
    path: REGISTERS,
    idArg: "registerId",
    idDescription: "The register's id (its publicId / handle)",
    root: "register",
    idField: "publicId",
    createdId: "register.publicId",
    createBody: "registerBody",
    createCompare: ["name", "type"],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "registerBody",
    updateFields: ["name", "schema", "flowSchema", "type"],
    updateCompare: ["name", "type"],
    createDescription:
      "Create a register: its name, form schema (steps → sections → fields) and flow. Read a field type's shape with eregister_get_field_types first.",
    updateDescription:
      "Replace a register's name, form schema and flow. Send the whole schema (read it with eregister_get_register and change it): fields left out are removed.",
    deleteDescription: "Delete a register and hide its entries.",
  },
  {
    noun: "code_block",
    path: `${COMPANY}/code-blocks`,
    idArg: "codeBlockId",
    idDescription: "The code block's publicId",
    root: "data",
    idField: "publicId",
    createdId: "codeblock.publicId",
    readQuery: { includeSource: "true" },
    createBody: "createCodeblockBody",
    createRequired: ["sourceFiles"],
    createCompare: ["name", "description", "type", "inputSchema", "outputSchema", "sourceFiles"],
    renamed: { type: "typeInt" },
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "updateCodeblockBody",
    updateFields: ["name", "description", "inputSchema", "outputSchema", "sourceFiles"],
    updateCompare: ["name", "description", "inputSchema", "outputSchema", "sourceFiles"],
    createDescription:
      "Create a code block with its TypeScript source files (sourceFiles, in fileName order; index.ts holds the default export). It starts as a draft: deploy it in eRegister.",
    updateDescription:
      "Change a code block's name, description, input / output schema or source. sourceFiles is the whole file set, in fileName order: files left out are deleted.",
    deleteDescription: "Delete a code block.",
  },
  {
    noun: "layout",
    path: `${COMPANY}/layouts`,
    idArg: "layoutId",
    idDescription: "The layout's pid",
    root: "data",
    idField: "pid",
    createdId: "data.pid",
    readQuery: { includeContent: "true" },
    createBody: "createLayoutBody",
    createRequired: ["content"],
    createCompare: [
      "name",
      "category",
      "layoutType",
      "defaultPrintFormat",
      "inputSchema",
      "content",
    ],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "updateLayoutBody",
    updateFields: ["name", "defaultPrintFormat", "inputSchema", "content"],
    updateCompare: ["name", "defaultPrintFormat", "inputSchema", "content"],
    createDescription:
      "Create a print or email layout from its template text: Lexical JSON or an HTML / Liquid template (content). A Word (Docx) layout must be uploaded in eRegister.",
    updateDescription:
      "Change a layout's name, print format, input schema or template text (content). A Word (Docx) layout's file can't be changed here.",
    deleteDescription: "Delete a layout.",
  },
  {
    noun: "action",
    path: `${COMPANY}/actions`,
    idArg: "actionId",
    idDescription: "The action's publicId",
    root: "action",
    idField: "publicId",
    createdId: "action.publicId",
    createBody: "actionBody",
    createCompare: ["name", "description", "isEnabled", "flowSchema", "steps"],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "actionBody",
    updateFields: ["name", "description", "flowSchema", "isEnabled", "triggers", "steps"],
    updateCompare: ["name", "description", "isEnabled", "flowSchema", "steps"],
    createDescription:
      "Create an action: its triggers, its code block steps and the flow between them.",
    updateDescription:
      "Replace an action's name, triggers, steps and flow. Send the whole action (read it with eregister_get_action and change it).",
    deleteDescription: "Delete an action.",
  },
  {
    noun: "report",
    path: `${COMPANY}/reports-v2`,
    idArg: "reportId",
    idDescription: "The report's id",
    root: "data",
    idField: "id",
    createdId: "data.id",
    createBody: "createReportBody",
    // DEV_NOTE: ReportV2Type.Advanced in eRegister: the only report type its API creates
    createConstants: { type: 2 },
    createCompare: [
      "name",
      "description",
      "sqlQuery",
      "inputSchema",
      "outputSchema",
      "transformCodeblockPid",
    ],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "updateReportBody",
    updateFields: [
      "name",
      "description",
      "sqlQuery",
      "inputSchema",
      "outputSchema",
      "transformCodeblockPid",
    ],
    updateCompare: [
      "name",
      "description",
      "sqlQuery",
      "inputSchema",
      "outputSchema",
      "transformCodeblockPid",
    ],
    createDescription:
      "Create a SQL report: its query (may use {{ input.fieldId }} placeholders), input sections and output columns.",
    updateDescription:
      "Change a report's name, description, SQL, input sections or output columns.",
    deleteDescription: "Delete a report and its charts.",
  },
  {
    noun: "report_chart",
    path: `${COMPANY}/reports-v2/{args.reportId}/charts`,
    pathArgs: REPORT_ID,
    idArg: "chartId",
    idDescription: "The chart's id",
    root: "data",
    idField: "id",
    createdId: "data.id",
    createBody: "createChartBody",
    createCompare: ["name", "config"],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "updateChartBody",
    updateFields: ["name", "config"],
    updateCompare: ["name", "config"],
    createDescription: "Create a chart on a report's results.",
    updateDescription: "Change a report chart's name or config.",
    deleteDescription: "Delete a report chart.",
  },
  {
    noun: "dashboard",
    path: `${COMPANY}/dashboards-v2`,
    idArg: "dashboardId",
    idDescription: "The dashboard's id",
    root: "data",
    idField: "id",
    createdId: "data.id",
    createBody: "createDashboardBody",
    createCompare: ["name", "description", "inputSchema"],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "updateDashboardBody",
    updateFields: ["name", "description", "inputSchema"],
    updateCompare: ["name", "description", "inputSchema"],
    createDescription:
      "Create a dashboard with its input (filter) sections. Add widgets with eregister_create_widget.",
    updateDescription: "Change a dashboard's name, description or input sections.",
    deleteDescription: "Delete a dashboard and its widgets.",
  },
  {
    noun: "widget",
    path: `${COMPANY}/widgets`,
    idArg: "widgetId",
    idDescription: "The widget's id",
    root: "data",
    idField: "id",
    createdId: "data.id",
    createBody: "createWidgetBody",
    createExtra: {
      entityType: {
        type: "integer",
        enum: [1, 2],
        description: "Where the widget goes: 1 = a dashboard, 2 = a register",
      },
      entityId: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "The dashboard's id, or the register's handle",
      },
    },
    createRequired: ["entityType", "entityId"],
    createCompare: ["type", "layout", "mapping", "config"],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "updateWidgetBody",
    updateFields: ["type", "layout", "mapping", "config"],
    updateCompare: ["layout", "mapping", "config"],
    createDescription:
      "Add a widget (a report chart, markdown or a code block) to a dashboard or a register.",
    updateDescription:
      "Change a widget's layout and its mapping (chart, code block) or config (markdown). type must be the widget's own type.",
    deleteDescription: "Delete a widget.",
  },
  {
    noun: "button",
    path: `${COMPANY}/buttons`,
    idArg: "buttonId",
    idDescription: "The button's publicId",
    root: "data",
    idField: "publicId",
    createdId: "data.publicId",
    createBody: "createButtonBody",
    createCompare: ["name", "description", "status", "priority", "registerPid"],
    updateMethod: ToolOpMethodEnum.Put,
    updateBody: "updateButtonBody",
    updateFields: ["name", "description", "status", "priority"],
    updateCompare: ["name", "description", "status", "priority"],
    createDescription:
      "Create a button on a register that runs a code block or an action, or opens a link.",
    updateDescription:
      "Change a button's name, description, status or priority. Its execution and confirmation are changed in eRegister.",
    deleteDescription: "Delete a button.",
  },
];

export const EREGISTER_TOOL_DEFINITIONS: EregisterToolDefinition[] = [
  {
    name: "eregister_list_companies",
    description:
      "List the eRegister companies the user belongs to, with their ids. Every other eRegister tool needs one.",
    ...READ,
    ops: {
      inputSchema: { type: "object", properties: {} },
      callOp: { method: ToolOpMethodEnum.Get, path: "/user-companies" },
      readbackOp: null,
      inverseOp: null,
    },
  },
  {
    name: "eregister_get_field_types",
    description:
      "Without type: the register field types. With type: that field type's JSON Schema, to write it in a register, code block, layout, report or dashboard schema.",
    ...READ,
    ops: {
      inputSchema: buildEregisterInputSchema({
        extra: {
          type: { type: "string", minLength: 1, maxLength: 64, description: "A field type" },
        },
      }),
      callOp: {
        method: ToolOpMethodEnum.Get,
        path: `${COMPANY}/${EREGISTER_REGISTER_MODE}/field-types`,
        query: { type: "{args.type}" },
      },
      readbackOp: null,
      inverseOp: null,
    },
  },
  listTool({
    name: "eregister_list_registers",
    description: "List the registers the user can open in a company.",
    method: ToolOpMethodEnum.Get,
    path: `${COMPANY}/${EREGISTER_REGISTER_MODE}/user-registers`,
  }),
  listTool({
    name: "eregister_list_code_blocks",
    description: "List a company's code blocks, newest change first.",
    method: ToolOpMethodEnum.Post,
    path: `${COMPANY}/code-blocks/list`,
    args: PAGE_ARGS,
  }),
  listTool({
    name: "eregister_list_layouts",
    description: "List a company's print and email layouts.",
    method: ToolOpMethodEnum.Post,
    path: `${COMPANY}/layouts/list`,
    args: PAGE_ARGS,
  }),
  listTool({
    name: "eregister_list_actions",
    description: "List a company's actions.",
    method: ToolOpMethodEnum.Post,
    path: `${COMPANY}/actions/list`,
    args: PAGE_ARGS,
  }),
  listTool({
    name: "eregister_list_reports",
    description: "List a company's reports.",
    method: ToolOpMethodEnum.Get,
    path: `${COMPANY}/reports-v2`,
  }),
  listTool({
    name: "eregister_list_report_charts",
    description: "List a report's charts.",
    method: ToolOpMethodEnum.Get,
    path: `${COMPANY}/reports-v2/{args.reportId}/charts`,
    pathArgs: REPORT_ID,
  }),
  listTool({
    name: "eregister_list_dashboards",
    description: "List a company's dashboards.",
    method: ToolOpMethodEnum.Get,
    path: `${COMPANY}/dashboards-v2`,
  }),
  listTool({
    name: "eregister_list_widgets",
    description: "List the widgets on a dashboard or a register.",
    method: ToolOpMethodEnum.Post,
    path: `${COMPANY}/widgets/list`,
    args: {
      entityType: {
        type: "integer",
        enum: [1, 2],
        description: "1 = a dashboard, 2 = a register",
      },
      entityId: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "The dashboard's id, or the register's handle",
      },
    },
    required: ["entityType", "entityId"],
  }),
  listTool({
    name: "eregister_list_buttons",
    description: "List a company's buttons, across registers.",
    method: ToolOpMethodEnum.Post,
    path: `${COMPANY}/buttons/list`,
    args: PAGE_ARGS,
  }),
  ...AREAS.flatMap(areaTools),
];

import {
  ToolDefinitionApprovalIntEnum,
  ToolDefinitionIdempotencyModeIntEnum,
  ToolDefinitionRiskIntEnum,
  ToolDefinitionSourceIntEnum,
  type ToolDefinitionBase,
} from "../toolDefinitions/ToolDefinitionsCommon";
import { ToolOpMethodEnum } from "../toolDefinitions/ToolOpsV1";
import { TestHostRecordStatusEnum } from "./TestHostCommon";

// DEV_NOTE: The test company's tool definitions over the test host's record API (M3-3). The seed script
// (pnpm --filter test-host seed) stores them on the test host connection; backend tests render them against the test
// host. One tool per path through the action engine:
//   list_records, get_record: reads.
//   update_record: write, Emulated (the adapter sends no key: a lost answer is proved by reading the record back with
//     the args, as for a host without Idempotency-Key). Undo PATCHes the read-before values back.
//   create_record: write, Native (Idempotency-Key): the new id is only in the call's response, so its readback and
//     undo read {result.*}, which an Emulated tool may not.
//   delete_record: destructive, Native. The read-before proves the record exists; undo PUTs the read-before record
//     back under the same id.
// Paths are relative to the connection's base_url ({issuer}/v1/). A change here is a new tool version on the next seed.
export type TestHostToolDefinition = Omit<ToolDefinitionBase, "connectionPublicId">;

const RECORD_ID_PROPERTY = {
  type: "string",
  description: "The record's id, e.g. rec_alpha",
  pattern: "^[A-Za-z0-9_-]{1,64}$",
};

const RECORD_FIELD_PROPERTIES = {
  name: { type: "string", description: "Display name", minLength: 1, maxLength: 200 },
  email: { type: "string", description: "Contact email", format: "email", maxLength: 320 },
  amount: { type: "number", description: "Amount in the account currency" },
  status: {
    type: "string",
    description: "Whether the record is in use",
    enum: [TestHostRecordStatusEnum.Active, TestHostRecordStatusEnum.Archived],
  },
};

const RECORD_COMPARE = {
  name: "data.name",
  email: "data.email",
  amount: "data.amount",
  status: "data.status",
};

export const TEST_HOST_TOOL_DEFINITIONS: TestHostToolDefinition[] = [
  {
    name: "list_records",
    description: "List records in id order, optionally only active or archived ones.",
    risk: ToolDefinitionRiskIntEnum.Read,
    idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.None,
    approval: ToolDefinitionApprovalIntEnum.Never,
    source: ToolDefinitionSourceIntEnum.Manual,
    ops: {
      inputSchema: {
        type: "object",
        properties: {
          status: RECORD_FIELD_PROPERTIES.status,
          limit: { type: "integer", description: "At most this many", minimum: 1, maximum: 100 },
        },
      },
      callOp: {
        method: ToolOpMethodEnum.Get,
        path: "/records",
        query: { status: "{args.status}", limit: "{args.limit}" },
      },
      readbackOp: null,
      inverseOp: null,
    },
  },
  {
    name: "get_record",
    description: "Read one record by id.",
    risk: ToolDefinitionRiskIntEnum.Read,
    idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.None,
    approval: ToolDefinitionApprovalIntEnum.Never,
    source: ToolDefinitionSourceIntEnum.Manual,
    ops: {
      inputSchema: {
        type: "object",
        properties: { recordId: RECORD_ID_PROPERTY },
        required: ["recordId"],
      },
      callOp: { method: ToolOpMethodEnum.Get, path: "/records/{args.recordId}" },
      readbackOp: null,
      inverseOp: null,
    },
  },
  {
    name: "update_record",
    description: "Change one or more fields of a record. Only the fields passed are changed.",
    risk: ToolDefinitionRiskIntEnum.Write,
    idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.Emulated,
    approval: ToolDefinitionApprovalIntEnum.Always,
    source: ToolDefinitionSourceIntEnum.Manual,
    ops: {
      inputSchema: {
        type: "object",
        properties: { recordId: RECORD_ID_PROPERTY, ...RECORD_FIELD_PROPERTIES },
        required: ["recordId"],
      },
      callOp: {
        method: ToolOpMethodEnum.Patch,
        path: "/records/{args.recordId}",
        bodyMap: {
          name: "{args.name}",
          email: "{args.email}",
          amount: "{args.amount}",
          status: "{args.status}",
        },
      },
      readbackOp: {
        method: ToolOpMethodEnum.Get,
        path: "/records/{args.recordId}",
        compare: RECORD_COMPARE,
      },
      inverseOp: {
        method: ToolOpMethodEnum.Patch,
        path: "/records/{args.recordId}",
        bodyMap: {
          name: "{before.data.name}",
          email: "{before.data.email}",
          amount: "{before.data.amount}",
          status: "{before.data.status}",
        },
      },
    },
  },
  {
    name: "create_record",
    description: "Create a new record. Status defaults to active.",
    risk: ToolDefinitionRiskIntEnum.Write,
    idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.Native,
    approval: ToolDefinitionApprovalIntEnum.Always,
    source: ToolDefinitionSourceIntEnum.Manual,
    ops: {
      inputSchema: {
        type: "object",
        properties: RECORD_FIELD_PROPERTIES,
        required: ["name", "email", "amount"],
      },
      callOp: {
        method: ToolOpMethodEnum.Post,
        path: "/records",
        bodyMap: {
          name: "{args.name}",
          email: "{args.email}",
          amount: "{args.amount}",
          status: "{args.status}",
        },
      },
      readbackOp: {
        method: ToolOpMethodEnum.Get,
        path: "/records/{result.data.id}",
        compare: RECORD_COMPARE,
      },
      inverseOp: { method: ToolOpMethodEnum.Delete, path: "/records/{result.data.id}" },
    },
  },
  {
    name: "delete_record",
    description: "Delete a record by id.",
    risk: ToolDefinitionRiskIntEnum.Destructive,
    idempotencyMode: ToolDefinitionIdempotencyModeIntEnum.Native,
    approval: ToolDefinitionApprovalIntEnum.Always,
    source: ToolDefinitionSourceIntEnum.Manual,
    ops: {
      inputSchema: {
        type: "object",
        properties: { recordId: RECORD_ID_PROPERTY },
        required: ["recordId"],
      },
      callOp: { method: ToolOpMethodEnum.Delete, path: "/records/{args.recordId}" },
      readbackOp: {
        method: ToolOpMethodEnum.Get,
        path: "/records/{args.recordId}",
        compare: { recordId: "data.id" },
      },
      inverseOp: {
        method: ToolOpMethodEnum.Put,
        path: "/records/{args.recordId}",
        bodyMap: {
          name: "{before.data.name}",
          email: "{before.data.email}",
          amount: "{before.data.amount}",
          status: "{before.data.status}",
        },
      },
    },
  },
];

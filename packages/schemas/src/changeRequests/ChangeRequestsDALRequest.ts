import type {
  ChangeRequest,
  ChangeRequestErrorCodeEnum,
  ChangeRequestStatusIntEnum,
} from "./ChangeRequestsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS. The DAL generates
// the publicId and checks the conversation and the tool call exist in the company. The payload arrives encrypted.
export type CreateChangeRequestDALRequest = Pick<
  ChangeRequest,
  | "companyId"
  | "conversationId"
  | "toolCallId"
  | "status"
  | "encryptedChanges"
  | "iv"
  | "encryptionKeyVersion"
  | "summary"
  | "changeCount"
>;

// DEV_NOTE: A change request of one conversation, by its public id. isForUpdate locks it for the rest of the
// transaction, so a status change reads and writes the status with no other step in between.
export type FindChangeRequestDALRequest = Pick<
  ChangeRequest,
  "companyId" | "conversationId" | "publicId"
> & {
  isForUpdate: boolean;
};

// DEV_NOTE: Moves a change request to status, only from one of fromStatuses (the row matches nothing otherwise:
// isNotFound). idempotencyKey and errorCode are set when given (errorCode null clears it); so are hostRef and an
// encrypted payload (M3-6: the commit's result, the read-after's mismatches), in the same update as the status, and
// undoUntil (M3-7: the end of the undo window and of the values' life; null clears it).
export type UpdateChangeRequestStatusDALRequest = Pick<
  ChangeRequest,
  "companyId" | "id" | "status"
> & {
  fromStatuses: ChangeRequestStatusIntEnum[];
  idempotencyKey?: string;
  errorCode?: ChangeRequestErrorCodeEnum | null;
  hostRef?: string | null;
  payload?: Pick<ChangeRequest, "encryptedChanges" | "iv" | "encryptionKeyVersion">;
  undoUntil?: Date | null;
};

// DEV_NOTE: Platform (withPlatform, every company): nulls the values (encrypted_changes, iv, encryption_key_version)
// of at most limit change requests whose undo_until is before `before`, except a Verified one whose user undo is under
// way (M3-7), until its undo_until + CHANGE_REQUEST_UNDO_GRACE_MS
export interface PurgeChangeRequestValuesDALRequest {
  before: Date;
  limit: number;
}

// DEV_NOTE: The durable pause's execution id, set once (only while still null)
export type SetChangeRequestExecutionIdDALRequest = Pick<
  ChangeRequest,
  "companyId" | "conversationId" | "publicId"
> & {
  thinkExecutionId: string;
};

export type ListConversationChangeRequestsDALRequest = Pick<
  ChangeRequest,
  "companyId" | "conversationId"
> & {
  publicIds: string[];
};

// DEV_NOTE: An edit's new payload (encrypted) and the summary and change count from its diff, only while the row is
// still Proposed (isNotFound otherwise); sets was_edited
export type UpdateChangeRequestPayloadDALRequest = Pick<
  ChangeRequest,
  | "companyId"
  | "id"
  | "encryptedChanges"
  | "iv"
  | "encryptionKeyVersion"
  | "summary"
  | "changeCount"
>;

// DEV_NOTE: How many of the company's change requests are in one status now (Overview's needs attention, M4-3).
// chatbotId set = only that chatbot's (through the conversation); null = the whole company.
export type CountChangeRequestsByStatusDALRequest = Pick<ChangeRequest, "companyId" | "status"> & {
  chatbotId: string | null;
};

// DEV_NOTE: One change request by its public id within the company, for the dashboard (M4-4): no conversation needed
export type FindDashboardChangeRequestDALRequest = Pick<ChangeRequest, "companyId" | "publicId">;

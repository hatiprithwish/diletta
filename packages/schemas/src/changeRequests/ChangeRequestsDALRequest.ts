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
// isNotFound). idempotencyKey and errorCode are set when given (errorCode null clears it).
export type UpdateChangeRequestStatusDALRequest = Pick<
  ChangeRequest,
  "companyId" | "id" | "status"
> & {
  fromStatuses: ChangeRequestStatusIntEnum[];
  idempotencyKey?: string;
  errorCode?: ChangeRequestErrorCodeEnum | null;
};

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

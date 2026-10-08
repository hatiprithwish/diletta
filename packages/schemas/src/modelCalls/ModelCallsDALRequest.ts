import type { ModelCall } from "./ModelCallsCommon";

// DEV_NOTE: Every tenant DAL request carries companyId — every query filters on it, on top of RLS.
// The DAL generates publicId; reference ids are checked before the insert.
export type CreateModelCallDALRequest = Omit<
  ModelCall,
  "id" | "publicId" | "createdAt" | "updatedAt"
>;

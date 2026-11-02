import type { ApiResponse } from "../common";
import type { EncryptedValue } from "./CryptoCommon";

// DEV_NOTE: Server-side only: a row's internal id and its stored ciphertext + iv
export type ValueOnKeyVersion = {
  id: string;
  encryptedValue: EncryptedValue;
};

export interface ValuesOnKeyVersionDALResponse extends ApiResponse {
  values?: ValueOnKeyVersion[];
}

// DEV_NOTE: isUpdated false = the row changed since it was read (compare-and-set missed): not a failure
export interface UpdateReEncryptedValueDALResponse extends ApiResponse {
  isUpdated?: boolean;
}

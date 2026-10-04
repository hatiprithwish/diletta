import type { ApiResponse } from "../common";

// The master key comes back as a non-extractable WebCrypto key: callers can encrypt and
// decrypt with it, but can never read its bytes back out.
export interface MasterKeyResponse extends ApiResponse {
  masterKey?: CryptoKey;
}

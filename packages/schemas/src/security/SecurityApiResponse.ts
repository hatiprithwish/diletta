import type { ApiResponse, TotalRecordsResponse } from "../common";
import type {
  CompanyConnectionEnvironmentIntEnum,
  CompanyConnectionEnvironmentLabelEnum,
  CompanyConnectionStatusIntEnum,
  CompanyConnectionStatusLabelEnum,
} from "../companyConnections/CompanyConnectionsCommon";
import type {
  CompanyEncryptionKeyStatusIntEnum,
  CompanyEncryptionKeyStatusLabelEnum,
} from "../companyEncryptionKeys/CompanyEncryptionKeysCommon";
import type {
  QualityIssueStatusIntEnum,
  QualityIssueStatusLabelEnum,
} from "../qualityIssues/QualityIssuesCommon";
import type { EncryptionKeyRotateFailureEnum } from "./SecurityCommon";

// DEV_NOTE: A connection as Identity and origins shows it: how the widget proves who the user is (the issuer, its signing
// keys' last fetch from the JWKS cache, null = not fetched or expired) and where it may run. No auth settings, base URL
// or internal id.
export interface SecurityConnection {
  publicId: string;
  environment: CompanyConnectionEnvironmentIntEnum;
  environmentLabel: CompanyConnectionEnvironmentLabelEnum;
  status: CompanyConnectionStatusIntEnum;
  statusLabel: CompanyConnectionStatusLabelEnum;
  jwtIssuer: string;
  allowedOrigins: string[];
  signingKeysFetchedAt: string | null;
}

// DEV_NOTE: Settings › Connections (M4-10): the Security view plus how the assistant reaches the host: the API address
// and the sign-in method in words. Never auth settings or a credential.
export interface SettingsConnection extends SecurityConnection {
  baseUrl: string | null;
  signInLabel: string;
}

export interface GetSettingsConnectionsApiResponse extends ApiResponse {
  connections?: SettingsConnection[];
}

export interface GetSecurityConnectionsApiResponse extends ApiResponse {
  connections?: SecurityConnection[];
}

export interface UpdateAllowedOriginsApiResponse extends ApiResponse {
  connection?: SecurityConnection;
}

// DEV_NOTE: One version of the company key: never its bytes or master key version. rotatedAt = when it stopped being the
// active key (null while active).
export interface SecurityEncryptionKey {
  version: number;
  status: CompanyEncryptionKeyStatusIntEnum;
  statusLabel: CompanyEncryptionKeyStatusLabelEnum;
  createdAt: string;
  rotatedAt: string | null;
}

// DEV_NOTE: Newest version first. isRotationInProgress: a Retiring key is waiting for the rotation job, so Rotate key is
// refused until it finishes.
export interface GetSecurityEncryptionKeysApiResponse extends ApiResponse {
  encryptionKeys?: SecurityEncryptionKey[];
  isRotationInProgress?: boolean;
}

export interface RotateEncryptionKeyApiResponse extends GetSecurityEncryptionKeysApiResponse {
  failure?: EncryptionKeyRotateFailureEnum;
}

// DEV_NOTE: The days in force, and whether that is the platform default (nothing chosen yet)
export interface ContentRetention {
  contentRetentionDays: number;
  isDefault: boolean;
}

export interface GetContentRetentionApiResponse extends ApiResponse {
  retention?: ContentRetention;
}

export type UpdateContentRetentionApiResponse = GetContentRetentionApiResponse;

// DEV_NOTE: A prompt-injection event: for now a quality issue typed Prompt injection. detectedIn = the admin's note,
// else where the issue came from; the conversation's title is null once purged.
export interface InjectionEvent {
  publicId: string;
  conversationPublicId: string;
  conversationTitle: string | null;
  detectedIn: string;
  status: QualityIssueStatusIntEnum;
  statusLabel: QualityIssueStatusLabelEnum;
  actionLabel: string;
  createdAt: string;
}

export interface GetInjectionEventsApiResponse extends ApiResponse {
  injectionEvents?: InjectionEvent[];
}

export type GetInjectionEventsCountApiResponse = TotalRecordsResponse;

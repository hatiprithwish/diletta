import type { ApiResponse, TotalRecordsResponse } from "../common";
import type { ModelProviderEnum } from "../companySecrets/CompanySecretsCommon";
import type { ConfigSpecBody } from "../configSpec/ConfigSpecRegistry";
import type {
  ToolDefinitionRiskIntEnum,
  ToolDefinitionRiskLabelEnum,
} from "../toolDefinitions/ToolDefinitionsCommon";
import type {
  ChatbotConfig,
  ChatbotConfigFailureEnum,
  ChatbotConfigStatusIntEnum,
  ChatbotConfigStatusLabelEnum,
  ChatbotConfigTestResultEnum,
} from "./ChatbotConfigsCommon";

// DEV_NOTE: One row of a chatbot's versions: no internal id, no body. editedByName = the admin who last saved it (else
// who created it), null for a system row or a removed admin.
export type ChatbotConfigVersion = Pick<
  ChatbotConfig,
  "publicId" | "configVersion" | "schemaVersion"
> & {
  chatbotConfigStatus: ChatbotConfigStatusIntEnum;
  chatbotConfigStatusLabel: ChatbotConfigStatusLabelEnum;
  editedByName: string | null;
  testResult: ChatbotConfigTestResultEnum;
  publishedAt: string | null; // ISO time
  createdAt: string; // ISO time
  updatedAt: string; // ISO time
};

// DEV_NOTE: One version with its body as the company stored it (upgraded, no platform defaults: readConfigBody). body
// null = the stored body no longer reads (bodyIssue says why); such a version can't be copied. failedSafetyCaseCount =
// the safety cases its newest run decided failed (0 with no run, or none decided yet): any one blocks publishing (M5-4).
export type ChatbotConfigDetail = ChatbotConfigVersion & {
  chatbotPublicId: string;
  body: ConfigSpecBody | null;
  bodyIssue: string | null;
  failedSafetyCaseCount: number;
};

export interface GetChatbotConfigsApiResponse extends ApiResponse {
  chatbotConfigs?: ChatbotConfigVersion[];
}

export type GetChatbotConfigsCountApiResponse = TotalRecordsResponse;

// DEV_NOTE: A tool version the editor may pin: Active only (publish refuses any other)
export interface ChatbotConfigToolOption {
  name: string;
  version: number;
  description: string;
  risk: ToolDefinitionRiskIntEnum;
  riskLabel: ToolDefinitionRiskLabelEnum;
}

export interface ChatbotConfigSourceOption {
  publicId: string;
  name: string;
}

// DEV_NOTE: What the editor's pickers offer, plus the providers that have an Active model key (a routing tier on any
// other provider can be saved, but not published). Models come from Schemas.MODEL_PRICES on the client.
export interface ChatbotConfigOptions {
  tools: ChatbotConfigToolOption[];
  knowledgeSources: ChatbotConfigSourceOption[];
  activeKeyProviders: ModelProviderEnum[];
}

export interface GetChatbotConfigOptionsApiResponse extends ApiResponse {
  options?: ChatbotConfigOptions;
}

export interface ChatbotConfigPin {
  name: string;
  version: number;
}

// DEV_NOTE: Every draft write, gate move and the publish answer the same shape. A refusal names its failure, and a
// send to testing or publish refusal what to fix: the providers with no Active key, the pins that aren't Active, the
// models with no price.
export interface ChatbotConfigWriteApiResponse extends ApiResponse {
  chatbotConfig?: ChatbotConfigDetail;
  failure?: ChatbotConfigFailureEnum;
  missingKeyProviders?: ModelProviderEnum[];
  inactiveTools?: ChatbotConfigPin[];
  unpricedModels?: string[];
}

export interface GetChatbotConfigApiResponse extends ApiResponse {
  chatbotConfig?: ChatbotConfigDetail;
}

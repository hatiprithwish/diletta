import type { PromptInjectionLocationEnum, PromptInjectionRuleEnum } from "./PromptInjectionCommon";

// DEV_NOTE: Server-side only (Conversation DO → PromptInjectionRepo → PromptInjectionProvider, M6-4). Every id is
// internal and comes from the DO's verified session; never the text that was found.
export interface RecordPromptInjectionRequest {
  companyId: string;
  conversationId: string;
  conversationPublicId: string;
  location: PromptInjectionLocationEnum;
  ruleId: PromptInjectionRuleEnum;
}

import type {
  PromptInjectionLocationEnum,
  PromptInjectionRuleEnum,
  PromptInjectionSource,
} from "./PromptInjectionCommon";

// DEV_NOTE: Server-side only (Conversation DO → PromptInjectionRepo → PromptInjectionProvider, M6-4). Every id is
// internal and comes from the DO's verified session; source names the help doc or the host tool and field, never the
// text that was found.
export interface RecordPromptInjectionRequest {
  companyId: string;
  conversationId: string;
  conversationPublicId: string;
  location: PromptInjectionLocationEnum;
  ruleId: PromptInjectionRuleEnum;
  source: PromptInjectionSource;
}

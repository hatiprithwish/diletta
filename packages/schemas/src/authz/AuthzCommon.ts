// DEV_NOTE: Every dashboard and operator action, checked by can(). Add an action here before the route that
// performs it; M4 pages add theirs as they land. Values are "<resource>.<verb>".
export enum AuthzActionEnum {
  // Chatbots (company-scoped)
  ChatbotRead = "chatbot.read",
  ChatbotCreate = "chatbot.create",
  ChatbotUpdate = "chatbot.update",

  // Knowledge sources and their documents (company-scoped)
  KnowledgeSourceRead = "knowledge_source.read",
  KnowledgeSourceCreate = "knowledge_source.create",
  KnowledgeSourceUpdate = "knowledge_source.update",
  KnowledgeSourceDelete = "knowledge_source.delete",

  // Insights pages (company-scoped, M4-3): Overview, Usage, Impact read the activity rollups; Impact's minutes per task
  InsightRead = "insight.read",
  RoiAssumptionUpdate = "roi_assumption.update",

  // Conversations page (company-scoped, M4-4): list, transcript and export; an admin flags one into the quality inbox
  ConversationRead = "conversation.read",
  QualityIssueCreate = "quality_issue.create",

  // Changes (company-scoped, M4-4 detail; M4-5 adds the list, timeline and resolve)
  ChangeRequestRead = "change_request.read",

  // Companies (operator only, across companies)
  CompanyCreate = "company.create",
  CompanyList = "company.list",

  // Tool definitions (operator only, on one company named by the route): curated from the host's API by operators
  ToolDefinitionRead = "tool_definition.read",
  ToolDefinitionCreate = "tool_definition.create",
  ToolDefinitionUpdate = "tool_definition.update",
  ToolDefinitionDelete = "tool_definition.delete",

  // Activity rollups (operator only, on one company named by the route): rebuild a range of days by hand
  ActivityRollupRebuild = "activity_rollup.rebuild",
}

// DEV_NOTE: Actions only an operator may perform. Everything else is company-scoped: an operator may perform it
// on any company, a company admin only on their own.
export const OPERATOR_ONLY_ACTIONS: ReadonlySet<AuthzActionEnum> = new Set([
  AuthzActionEnum.CompanyCreate,
  AuthzActionEnum.CompanyList,
  AuthzActionEnum.ToolDefinitionRead,
  AuthzActionEnum.ToolDefinitionCreate,
  AuthzActionEnum.ToolDefinitionUpdate,
  AuthzActionEnum.ToolDefinitionDelete,
  AuthzActionEnum.ActivityRollupRebuild,
]);

// DEV_NOTE: The company a resource belongs to (internal companies.id, resolved server-side). null = no single
// company: a platform resource such as the company list.
export interface AuthzResource {
  companyId: string | null;
}

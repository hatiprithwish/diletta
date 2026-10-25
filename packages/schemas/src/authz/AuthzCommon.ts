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

  // Knowledge page (company-scoped, M4-7): read the questions the assistant couldn't answer, grouped; close a group with
  // the document that answers it, or dismiss it
  DocGapClusterRead = "doc_gap_cluster.read",
  DocGapClusterUpdate = "doc_gap_cluster.update",

  // Insights pages (company-scoped, M4-3): Overview, Usage, Impact read the activity rollups; Impact's minutes per task
  InsightRead = "insight.read",
  RoiAssumptionUpdate = "roi_assumption.update",

  // Conversations page (company-scoped, M4-4): list, transcript and export; an admin flags one into the quality inbox
  ConversationRead = "conversation.read",
  QualityIssueCreate = "quality_issue.create",

  // Quality page (company-scoped, M4-6): read the inbox; triage, mark fixed or dismiss an issue; turn one into a test
  QualityIssueRead = "quality_issue.read",
  QualityIssueUpdate = "quality_issue.update",
  EvalCaseCreate = "eval_case.create",

  // Tests page (company-scoped, M4-8): read runs, their results and transcripts, and cases; write and edit a case, or turn
  // one on or off (EvalCaseCreate above covers New case too). Running tests comes with the harness (M5-2).
  EvalRunRead = "eval_run.read",
  EvalCaseRead = "eval_case.read",
  EvalCaseUpdate = "eval_case.update",

  // Changes (company-scoped, M4-4 detail; M4-5 the list and timeline): read; mark one that needs a person resolved
  ChangeRequestRead = "change_request.read",
  ChangeRequestResolve = "change_request.resolve",

  // Security page (company-scoped, M4-9): read the audit log (every admin and operator write on the company)…
  AuditLogRead = "audit_log.read",
  // and the rest of the page: read identity and origins, keys, retention and prompt-injection events; change where the
  // widget may run, rotate the company key, set how long chat content is kept
  SecurityRead = "security.read",
  ConnectionOriginsUpdate = "company_connection.origins_update",
  EncryptionKeyRotate = "company_encryption_key.rotate",
  RetentionUpdate = "company.retention_update",

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

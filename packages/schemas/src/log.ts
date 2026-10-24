export enum LogCategory {
  Route = "Route",
  DAL = "DAL",
  Repo = "Repo",
  Middleware = "Middleware",
  DB = "DB",
  Crypto = "Crypto",
  Relay = "Relay",
  Queue = "Queue",
  Authz = "Authz",
  Partition = "Partition",
  Cron = "Cron",
  Widget = "Widget",
  ModelRouter = "ModelRouter",
  Conversation = "Conversation",
  Budget = "Budget",
  Knowledge = "Knowledge",
  Feedback = "Feedback",
  Action = "Action",
  Rollup = "Rollup",
  Insights = "Insights",
}

export enum LogAction {
  // Auth
  VerifyToken = "VerifyToken",
  SignOut = "SignOut",
  GetClerkAdminProfile = "GetClerkAdminProfile",
  ConsumeClerkInvite = "ConsumeClerkInvite",
  Authorize = "Authorize",

  // Admins
  GetAdminByClerkUserId = "GetAdminByClerkUserId",
  CreateAdmin = "CreateAdmin",
  UpdateAdminEmail = "UpdateAdminEmail",

  // Tenant transactions
  WithTenant = "WithTenant",
  WithPlatform = "WithPlatform",

  // Companies
  CreateCompany = "CreateCompany",
  GetCompanyDetails = "GetCompanyDetails",
  GetCompanyByPublicId = "GetCompanyByPublicId",
  ListCompanies = "ListCompanies",
  CountCompanies = "CountCompanies",
  ListCompanyIdsByStatus = "ListCompanyIdsByStatus",
  UpdateCompany = "UpdateCompany",

  // Chatbot users
  CreateChatbotUser = "CreateChatbotUser",
  GetChatbotUserDetails = "GetChatbotUserDetails",
  ListChatbotUsers = "ListChatbotUsers",
  CountChatbotUsers = "CountChatbotUsers",
  UpdateChatbotUser = "UpdateChatbotUser",

  // Company connections
  CreateCompanyConnection = "CreateCompanyConnection",
  GetCompanyConnectionDetails = "GetCompanyConnectionDetails",
  ListCompanyConnections = "ListCompanyConnections",
  UpdateCompanyConnection = "UpdateCompanyConnection",
  GetCompanyConnectionByIssuer = "GetCompanyConnectionByIssuer",

  // Chatbots
  CreateChatbot = "CreateChatbot",
  GetChatbotDetails = "GetChatbotDetails",
  ListChatbots = "ListChatbots",
  UpdateChatbot = "UpdateChatbot",
  DeleteChatbot = "DeleteChatbot",
  ClearDefaultChatbot = "ClearDefaultChatbot",
  SetDefaultChatbot = "SetDefaultChatbot",
  GetDefaultChatbot = "GetDefaultChatbot",

  // Widget auth
  DecodeWidgetJwt = "DecodeWidgetJwt",
  GetJwks = "GetJwks",
  VerifyWidgetJwt = "VerifyWidgetJwt",
  AuthenticateWidget = "AuthenticateWidget",
  GetWidgetBootstrap = "GetWidgetBootstrap",

  // Crypto
  ReadMasterKey = "ReadMasterKey",
  CreateCompanyKey = "CreateCompanyKey",
  UnwrapCompanyKey = "UnwrapCompanyKey",
  EncryptValue = "EncryptValue",
  DecryptValue = "DecryptValue",

  // Company encryption keys
  CreateCompanyEncryptionKey = "CreateCompanyEncryptionKey",
  GetCompanyEncryptionKeyDetails = "GetCompanyEncryptionKeyDetails",
  GetActiveCompanyEncryptionKey = "GetActiveCompanyEncryptionKey",
  ListCompanyEncryptionKeys = "ListCompanyEncryptionKeys",
  MarkCompanyEncryptionKeyRetiring = "MarkCompanyEncryptionKeyRetiring",

  // Company secrets
  CreateCompanySecret = "CreateCompanySecret",
  GetCompanySecretDetails = "GetCompanySecretDetails",
  ListCompanySecrets = "ListCompanySecrets",
  UpdateCompanySecret = "UpdateCompanySecret",
  GetActiveModelKey = "GetActiveModelKey",
  InvalidateModelKey = "InvalidateModelKey",

  // Chatbot user secrets
  CreateChatbotUserSecret = "CreateChatbotUserSecret",
  GetChatbotUserSecretDetails = "GetChatbotUserSecretDetails",
  ListChatbotUserSecrets = "ListChatbotUserSecrets",
  UpdateChatbotUserSecret = "UpdateChatbotUserSecret",

  // Model calls
  CreateModelCall = "CreateModelCall",
  GetPendingModelCalls = "GetPendingModelCalls",
  SettleModelCallUsage = "SettleModelCallUsage",
  TouchPendingModelCall = "TouchPendingModelCall",
  BackfillModelCallUsage = "BackfillModelCallUsage",

  // Quality issues
  LockOpenSystemQualityIssue = "LockOpenSystemQualityIssue",
  GetOpenSystemQualityIssue = "GetOpenSystemQualityIssue",
  CreateSystemQualityIssue = "CreateSystemQualityIssue",
  CreateUserQualityIssue = "CreateUserQualityIssue",
  UpdateQualityIssueNote = "UpdateQualityIssueNote",

  // Model router
  GetModel = "GetModel",
  CreateGatewayModel = "CreateGatewayModel",
  RecordModelCall = "RecordModelCall",
  HandleModelKeyFailure = "HandleModelKeyFailure",
  SyncReadModel = "SyncReadModel",
  CloseIdleConversation = "CloseIdleConversation",
  GetGatewayLogUsage = "GetGatewayLogUsage",

  // Budget
  GetModelCallCostSum = "GetModelCallCostSum",
  GetBudgetSeed = "GetBudgetSeed",
  LoadBudgetLedger = "LoadBudgetLedger",
  AdmitBudgetTurn = "AdmitBudgetTurn",
  ReserveBudget = "ReserveBudget",
  SettleBudget = "SettleBudget",
  ExpireBudgetReservation = "ExpireBudgetReservation",

  // Tool definitions
  CreateToolDefinition = "CreateToolDefinition",
  GetToolDefinitionDetails = "GetToolDefinitionDetails",
  ListToolDefinitions = "ListToolDefinitions",
  CountToolDefinitions = "CountToolDefinitions",
  GetToolConnection = "GetToolConnection",
  LockToolDefinitionName = "LockToolDefinitionName",
  GetToolDefinitionNameState = "GetToolDefinitionNameState",
  UpdateToolDefinitionDraft = "UpdateToolDefinitionDraft",
  SetToolDefinitionStatus = "SetToolDefinitionStatus",
  DeleteToolDefinitionDraft = "DeleteToolDefinitionDraft",
  LoadToolOps = "LoadToolOps",
  ResolveOperatorCompany = "ResolveOperatorCompany",
  GetPinnedToolDefinitions = "GetPinnedToolDefinitions",
  GetToolDefinitionById = "GetToolDefinitionById",

  // Action engine (tool calls, change requests)
  LoadTurnTools = "LoadTurnTools",
  RunHostTool = "RunHostTool",
  CreateToolCall = "CreateToolCall",
  ProposeChange = "ProposeChange",
  CreateChangeRequest = "CreateChangeRequest",
  GetChangeRequestDetails = "GetChangeRequestDetails",
  UpdateChangeRequestStatus = "UpdateChangeRequestStatus",
  SetChangeRequestExecutionId = "SetChangeRequestExecutionId",
  ListConversationChangeRequests = "ListConversationChangeRequests",
  DecideChangeRequest = "DecideChangeRequest",
  ExpireChangeRequest = "ExpireChangeRequest",
  CommitChangeRequest = "CommitChangeRequest",
  VerifyChangeRequest = "VerifyChangeRequest",
  UndoChangeRequest = "UndoChangeRequest",
  RequestHostToken = "RequestHostToken",
  HandOverChangeRequest = "HandOverChangeRequest",
  PurgeChangeRequestValues = "PurgeChangeRequestValues",
  EditChangeRequest = "EditChangeRequest",
  UpdateChangeRequestPayload = "UpdateChangeRequestPayload",
  ReceiveHostToken = "ReceiveHostToken",

  // Knowledge sources
  CreateKnowledgeSource = "CreateKnowledgeSource",
  GetKnowledgeSourceDetails = "GetKnowledgeSourceDetails",
  ListKnowledgeSources = "ListKnowledgeSources",
  CountKnowledgeSources = "CountKnowledgeSources",
  UpdateKnowledgeSource = "UpdateKnowledgeSource",
  SetKnowledgeSourceSyncState = "SetKnowledgeSourceSyncState",
  DeleteKnowledgeSource = "DeleteKnowledgeSource",
  GetDueKnowledgeSources = "GetDueKnowledgeSources",
  StartKnowledgeSync = "StartKnowledgeSync",
  StartDueKnowledgeSyncs = "StartDueKnowledgeSyncs",

  // Knowledge documents and chunks
  CreateKnowledgeDocument = "CreateKnowledgeDocument",
  GetKnowledgeDocumentDetails = "GetKnowledgeDocumentDetails",
  GetKnowledgeDocumentBySourceUrl = "GetKnowledgeDocumentBySourceUrl",
  UpdateKnowledgeDocument = "UpdateKnowledgeDocument",
  ListKnowledgeDocuments = "ListKnowledgeDocuments",
  CountKnowledgeDocuments = "CountKnowledgeDocuments",
  GetKnowledgeDocumentsBySource = "GetKnowledgeDocumentsBySource",
  GetUnlistedKnowledgeDocuments = "GetUnlistedKnowledgeDocuments",
  DeleteKnowledgeDocuments = "DeleteKnowledgeDocuments",
  DeleteKnowledgeDocumentsBySource = "DeleteKnowledgeDocumentsBySource",
  UploadKnowledgeDocument = "UploadKnowledgeDocument",
  CreateKnowledgeChunks = "CreateKnowledgeChunks",
  DeleteKnowledgeChunks = "DeleteKnowledgeChunks",

  // Knowledge ingestion
  RunKnowledgeSync = "RunKnowledgeSync",
  ListKnowledgeSyncItems = "ListKnowledgeSyncItems",
  IngestKnowledgeSyncItem = "IngestKnowledgeSyncItem",
  FetchKnowledgePage = "FetchKnowledgePage",
  ListSitemapUrls = "ListSitemapUrls",
  ExtractKnowledgeText = "ExtractKnowledgeText",
  EmbedKnowledgeChunks = "EmbedKnowledgeChunks",
  PruneKnowledgeDocuments = "PruneKnowledgeDocuments",
  FinishKnowledgeSync = "FinishKnowledgeSync",

  // Knowledge search
  GetKnowledgeSourceIds = "GetKnowledgeSourceIds",
  SearchKnowledgeChunksByVector = "SearchKnowledgeChunksByVector",
  SearchKnowledgeChunksByKeyword = "SearchKnowledgeChunksByKeyword",
  SearchKnowledge = "SearchKnowledge",
  RerankKnowledgeChunks = "RerankKnowledgeChunks",
  RecordKnowledgeModelCalls = "RecordKnowledgeModelCalls",

  // Files
  CreateFile = "CreateFile",
  SetFileOwner = "SetFileOwner",
  GetFile = "GetFile",
  DeleteFiles = "DeleteFiles",
  PutFileObject = "PutFileObject",
  GetFileObject = "GetFileObject",
  DeleteFileObjects = "DeleteFileObjects",

  // Chatbot configs
  GetPublishedChatbotConfig = "GetPublishedChatbotConfig",

  // Conversations
  CreateConversation = "CreateConversation",
  GetConversationDetails = "GetConversationDetails",
  SetConversationRootLog = "SetConversationRootLog",
  SetConversationConfig = "SetConversationConfig",
  TouchConversation = "TouchConversation",
  CloseConversation = "CloseConversation",
  StartConversation = "StartConversation",
  LoadTurnConfig = "LoadTurnConfig",
  RecordTurn = "RecordTurn",
  RunTurn = "RunTurn",
  FilterWidgetFrame = "FilterWidgetFrame",

  // Messages
  CreateMessages = "CreateMessages",
  ListMessages = "ListMessages",
  GetAssistantMessage = "GetAssistantMessage",

  // Feedback
  UpsertFeedback = "UpsertFeedback",
  ListConversationFeedback = "ListConversationFeedback",
  RecordFeedback = "RecordFeedback",

  // Activity log + outbox
  CreateActivityLog = "CreateActivityLog",
  GetActivityLogsByEntity = "GetActivityLogsByEntity",
  CreateEventOutbox = "CreateEventOutbox",
  GetEventOutboxByDedupeKey = "GetEventOutboxByDedupeKey",
  LockEventOutboxDedupeKey = "LockEventOutboxDedupeKey",
  LockPendingEventOutboxes = "LockPendingEventOutboxes",
  MarkEventOutboxesPublished = "MarkEventOutboxesPublished",
  SetEventOutboxLastError = "SetEventOutboxLastError",
  MarkEventOutboxAttemptFailed = "MarkEventOutboxAttemptFailed",
  DeletePublishedEventOutboxes = "DeletePublishedEventOutboxes",
  RelayEvents = "RelayEvents",
  SweepPendingEvents = "SweepPendingEvents",
  PurgePublishedEvents = "PurgePublishedEvents",
  ConsumeEvent = "ConsumeEvent",

  // Activity log partitions
  CreateActivityLogPartition = "CreateActivityLogPartition",
  GetActivityLogDefaultHasRows = "GetActivityLogDefaultHasRows",
  EnsureActivityLogPartitions = "EnsureActivityLogPartitions",

  // Activity rollups
  LockActivityRollupDay = "LockActivityRollupDay",
  DeleteActivityRollupDay = "DeleteActivityRollupDay",
  CreateActivityRollups = "CreateActivityRollups",
  GetConversationRollupGroups = "GetConversationRollupGroups",
  GetFeedbackRollupGroups = "GetFeedbackRollupGroups",
  GetChangeRequestRollupGroups = "GetChangeRequestRollupGroups",
  GetModelCallRollupGroups = "GetModelCallRollupGroups",
  RebuildActivityRollupDay = "RebuildActivityRollupDay",
  RebuildRecentActivityRollups = "RebuildRecentActivityRollups",
  GetActivityRollups = "GetActivityRollups",

  // Insights (M4-3)
  GetInsightsOverview = "GetInsightsOverview",
  GetInsightsUsage = "GetInsightsUsage",
  GetInsightsImpact = "GetInsightsImpact",
  CountChangeRequestsByStatus = "CountChangeRequestsByStatus",
  CountOpenQualityIssues = "CountOpenQualityIssues",
  GetFailedKnowledgeSourcesSummary = "GetFailedKnowledgeSourcesSummary",
  GetWriteToolSummaries = "GetWriteToolSummaries",
  GetAdminDetails = "GetAdminDetails",

  // ROI assumptions (M4-3)
  CreateRoiAssumption = "CreateRoiAssumption",
  GetRoiAssumptions = "GetRoiAssumptions",

  // Conversations page (M4-4)
  GetDashboardConversations = "GetDashboardConversations",
  CountDashboardConversations = "CountDashboardConversations",
  GetDashboardConversation = "GetDashboardConversation",
  ExportConversations = "ExportConversations",
  ListConversationMessages = "ListConversationMessages",
  ListConversationToolCalls = "ListConversationToolCalls",
  GetConversationTurnCosts = "GetConversationTurnCosts",
  GetChatbotConfigOptions = "GetChatbotConfigOptions",
  CreateAdminQualityIssue = "CreateAdminQualityIssue",
  FlagConversation = "FlagConversation",
  GetDashboardChangeRequest = "GetDashboardChangeRequest",

  // Changes page (M4-5)
  GetDashboardChangeRequests = "GetDashboardChangeRequests",
  CountDashboardChangeRequests = "CountDashboardChangeRequests",
  GetChangeRequestRequesters = "GetChangeRequestRequesters",
  GetActivityLogTimeline = "GetActivityLogTimeline",
  ResolveChangeRequest = "ResolveChangeRequest",

  // Quality page (M4-6)
  GetDashboardQualityIssues = "GetDashboardQualityIssues",
  CountDashboardQualityIssues = "CountDashboardQualityIssues",
  GetDashboardQualityIssue = "GetDashboardQualityIssue",
  TriageQualityIssue = "TriageQualityIssue",
  UpdateQualityIssueStatus = "UpdateQualityIssueStatus",
  CloseQualityIssue = "CloseQualityIssue",
  DraftQualityTest = "DraftQualityTest",
  ConvertQualityIssue = "ConvertQualityIssue",
  CreateEvalCase = "CreateEvalCase",

  // Cron
  DispatchCron = "DispatchCron",
}

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

  // Chatbot user secrets
  CreateChatbotUserSecret = "CreateChatbotUserSecret",
  GetChatbotUserSecretDetails = "GetChatbotUserSecretDetails",
  ListChatbotUserSecrets = "ListChatbotUserSecrets",
  UpdateChatbotUserSecret = "UpdateChatbotUserSecret",

  // Activity log + outbox
  CreateActivityLog = "CreateActivityLog",
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

  // Cron
  DispatchCron = "DispatchCron",
}

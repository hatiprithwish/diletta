export enum LogCategory {
  Route = "Route",
  DAL = "DAL",
  Repo = "Repo",
  Middleware = "Middleware",
  DB = "DB",
  Crypto = "Crypto",
  Relay = "Relay",
  Queue = "Queue",
}

export enum LogAction {
  // Auth
  VerifyToken = "VerifyToken",
  SyncClerkUser = "SyncClerkUser",
  SignOut = "SignOut",

  // User
  GetUserDetails = "GetUserDetails",

  // Tenant transactions
  WithTenant = "WithTenant",
  WithPlatform = "WithPlatform",

  // Companies
  CreateCompany = "CreateCompany",
  GetCompanyDetails = "GetCompanyDetails",
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

  // Chatbots
  CreateChatbot = "CreateChatbot",
  GetChatbotDetails = "GetChatbotDetails",
  ListChatbots = "ListChatbots",
  UpdateChatbot = "UpdateChatbot",
  DeleteChatbot = "DeleteChatbot",
  ClearDefaultChatbot = "ClearDefaultChatbot",
  SetDefaultChatbot = "SetDefaultChatbot",

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
  LockPendingEventOutboxes = "LockPendingEventOutboxes",
  MarkEventOutboxesPublished = "MarkEventOutboxesPublished",
  MarkEventOutboxAttemptFailed = "MarkEventOutboxAttemptFailed",
  DeletePublishedEventOutboxes = "DeletePublishedEventOutboxes",
  RecordCriticalEvent = "RecordCriticalEvent",
  RelayEvents = "RelayEvents",
  SweepPendingEvents = "SweepPendingEvents",
  PurgePublishedEvents = "PurgePublishedEvents",
  ConsumeEvent = "ConsumeEvent",
}

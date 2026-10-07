export enum LogCategory {
  Route = "Route",
  DAL = "DAL",
  Repo = "Repo",
  Middleware = "Middleware",
  DB = "DB",
  Crypto = "Crypto",
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
}

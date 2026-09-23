export enum LogCategory {
  Route = "Route",
  DAL = "DAL",
  Repo = "Repo",
  Middleware = "Middleware",
  DB = "DB",
}

export enum LogAction {
  // Auth
  VerifyToken = "VerifyToken",
  SyncClerkUser = "SyncClerkUser",
  SignOut = "SignOut",

  // User
  GetUserDetails = "GetUserDetails",

  // Notes
  CreateNote = "CreateNote",
  GetNoteDetails = "GetNoteDetails",
  ListNotes = "ListNotes",
  UpdateNote = "UpdateNote",
  DeleteNote = "DeleteNote",
}

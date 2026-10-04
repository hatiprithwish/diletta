import type { Note } from "./NotesCommon";
import type { ApiResponse } from "../common";

// DAL results carry the raw DB row (internal id + status int). The Repo maps them to API responses.
export interface NoteDALResponse extends ApiResponse {
  note?: Note;
}

export interface NotesDALResponse extends ApiResponse {
  notes?: Note[];
}

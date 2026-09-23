import type { NoteWithStatus } from "./NotesCommon";
import type { ApiResponse } from "../common";

export interface CreateNoteApiResponse extends ApiResponse {
  note?: NoteWithStatus;
}

export interface GetNoteApiResponse extends ApiResponse {
  note?: NoteWithStatus;
}

export interface GetNotesApiResponse extends ApiResponse {
  notes?: NoteWithStatus[];
}

export interface UpdateNoteApiResponse extends ApiResponse {
  note?: NoteWithStatus;
}

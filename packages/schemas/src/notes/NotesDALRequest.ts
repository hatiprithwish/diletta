import type { NullableDALFields } from "../common";
import type { Note, NoteBase } from "./NotesCommon";

export type CreateNoteDALRequest = NoteBase & Pick<Note, "userId">;

// Params to find a note by its public ID and user ID (for authorization)
export type FindNoteDALRequest = Pick<Note, "publicId" | "userId">;

export type GetNotesDALRequest = Pick<Note, "userId">;

export type UpdateNoteDALRequest = FindNoteDALRequest &
  NullableDALFields<Omit<Note, "id" | "publicId" | "userId" | "createdAt">>;

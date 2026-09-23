import { z } from "zod";
import { ZNoteBase } from "./NotesCommon";

export const ZCreateNoteApiRequest = z.object({
  note: ZNoteBase,
});
export type CreateNoteApiRequest = z.infer<typeof ZCreateNoteApiRequest>;

export const ZUpdateNoteApiRequest = z.object({
  note: ZNoteBase.partial(),
});
export type UpdateNoteApiRequest = z.infer<typeof ZUpdateNoteApiRequest>;

import z from "zod";

export enum NoteStatusIntEnum {
  Draft = 1,
  Published = 2,
  Archived = 3,
}

export enum NoteStatusLabelEnum {
  Draft = "Draft",
  Published = "Published",
  Archived = "Archived",
}

export const NOTE_STATUS_LABEL_MAP: Record<NoteStatusIntEnum, NoteStatusLabelEnum> = {
  [NoteStatusIntEnum.Draft]: NoteStatusLabelEnum.Draft,
  [NoteStatusIntEnum.Published]: NoteStatusLabelEnum.Published,
  [NoteStatusIntEnum.Archived]: NoteStatusLabelEnum.Archived,
};

// Create Note Body
export const ZNoteBase = z.object({
  title: z.string(),
  body: z.string().nullable().optional(),
});
export type NoteBase = z.infer<typeof ZNoteBase>;

// Whole Note Body — DB shape (status stored as integer)
// DEV_NOTE: id is the internal autoincrement PK — used by DAL/Repo for joins only, NEVER sent to a client
export const ZNote = ZNoteBase.extend({
  id: z.number(),
  publicId: z.string(),
  userId: z.string(),
  status: z.nativeEnum(NoteStatusIntEnum),
  createdAt: z.date(),
  updatedAt: z.date().nullable().optional(),
});
export type Note = z.infer<typeof ZNote>;

// API response shape — includes both int and label; id is structurally omitted, publicId is client-facing
export type NoteWithStatus = Omit<Note, "id"> & {
  noteStatus: NoteStatusIntEnum;
  noteStatusLabel: NoteStatusLabelEnum;
};

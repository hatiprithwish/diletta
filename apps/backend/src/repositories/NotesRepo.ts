import NotesDAL from "@/data-access-layer/NotesDAL";
import * as Schemas from "@app/schemas";

export default class NotesRepo {
  private dal: NotesDAL;

  constructor(env: Env) {
    this.dal = new NotesDAL(env);
  }

  private withStatusLabel(note: Schemas.Note): Schemas.NoteWithStatus {
    const { id: _id, ...rest } = note;
    return {
      ...rest,
      noteStatus: note.status,
      noteStatusLabel: Schemas.NOTE_STATUS_LABEL_MAP[note.status],
    };
  }

  private withNoteResponse(result: Schemas.NoteDALResponse): Schemas.GetNoteApiResponse {
    const { note, ...rest } = result;
    return { ...rest, note: note ? this.withStatusLabel(note) : undefined };
  }

  async createNote(
    params: Schemas.CreateNoteApiRequest & { userId: string },
  ): Promise<Schemas.CreateNoteApiResponse> {
    const result = await this.dal.createNote({
      userId: params.userId,
      title: params.note.title,
      body: params.note.body,
    });
    return this.withNoteResponse(result);
  }

  async getNoteDetails(params: {
    userId: string;
    publicId: string;
  }): Promise<Schemas.GetNoteApiResponse> {
    const result = await this.dal.getNoteDetails(params);
    return this.withNoteResponse(result);
  }

  async getNotes(params: { userId: string }): Promise<Schemas.GetNotesApiResponse> {
    const { notes, ...rest } = await this.dal.getNotes(params);
    return { ...rest, notes: notes?.map((note) => this.withStatusLabel(note)) };
  }

  async updateNote(
    params: Schemas.UpdateNoteApiRequest & { userId: string; publicId: string },
  ): Promise<Schemas.UpdateNoteApiResponse> {
    const result = await this.dal.updateNote({
      publicId: params.publicId,
      userId: params.userId,
      title: params.note.title ?? null,
      // DEV_NOTE: Pass body through as-is — undefined leaves it unchanged, null clears it
      body: params.note.body,
    });
    return this.withNoteResponse(result);
  }

  async deleteNote(params: { userId: string; publicId: string }) {
    return await this.dal.deleteNote(params);
  }
}

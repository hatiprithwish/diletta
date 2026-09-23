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

  async createNote(params: Schemas.CreateNoteApiRequest & { userId: string }) {
    const result = await this.dal.createNote({
      userId: params.userId,
      title: params.note.title,
      body: params.note.body,
    });
    if (result.isSuccess && result.note) {
      result.note = this.withStatusLabel(result.note);
    }
    return result;
  }

  async getNoteDetails(params: { userId: string; publicId: string }) {
    const result = await this.dal.getNoteDetails(params);
    if (result.isSuccess && result.note) {
      result.note = this.withStatusLabel(result.note);
    }
    return result;
  }

  async getNotes(params: { userId: string }) {
    const result = await this.dal.getNotes(params);
    if (result.isSuccess && result.notes) {
      result.notes = result.notes.map((note) => this.withStatusLabel(note));
    }
    return result;
  }

  async updateNote(params: Schemas.UpdateNoteApiRequest & { userId: string; publicId: string }) {
    const result = await this.dal.updateNote({
      publicId: params.publicId,
      userId: params.userId,
      title: params.note.title ?? null,
      body: params.note.body ?? null,
    });
    if (result.isSuccess && result.note) {
      result.note = this.withStatusLabel(result.note);
    }
    return result;
  }

  async deleteNote(params: { userId: string; publicId: string }) {
    return await this.dal.deleteNote(params);
  }
}

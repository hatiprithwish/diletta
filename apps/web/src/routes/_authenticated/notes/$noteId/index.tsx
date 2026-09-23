import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { useState } from "react";
import { NotesQueries, useUpdateNote, useDeleteNote } from "../-data";
import NoteHeader from "./-NoteHeader";
import ViewNote from "./-ViewNote";
import { NoteForm } from "./-NoteForm";
import type * as Schemas from "@app/schemas";

export const Route = createFileRoute("/_authenticated/notes/$noteId/")({
  component: NoteDetailPage,
});

function NoteDetailPage() {
  const noteId = Route.useParams().noteId;
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);

  const { data, isPending, isError } = useQuery(NotesQueries.detail(noteId, getToken));
  const note = data?.note;

  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();

  if (isPending) return <div>Loading...</div>;
  if (isError || !note) return <div>Note not found.</div>;

  // DEV_NOTE: mutateAsync used here — need to await save before closing the form.
  async function handleSubmit(value: Schemas.NoteBase) {
    await updateNote.mutateAsync({
      publicId: noteId,
      body: { note: value },
    });
    setIsEditing(false);
  }

  // DEV_NOTE: mutate (not mutateAsync) — no need to await, navigation happens in onSuccess.
  function handleDelete() {
    deleteNote.mutate(noteId, {
      onSuccess: () => navigate({ to: "/notes" }),
    });
  }

  return (
    <div className="mx-auto max-w-2xl p-6 flex flex-col gap-6">
      <NoteHeader
        isEditing={isEditing}
        isDeleting={deleteNote.isPending}
        onEdit={() => setIsEditing(true)}
        onDelete={handleDelete}
      />
      {isEditing ? (
        <NoteForm
          currentTitle={note.title}
          currentBody={note.body}
          onSubmit={handleSubmit}
          onCancel={() => setIsEditing(false)}
        />
      ) : (
        <ViewNote title={note.title} body={note.body} />
      )}
    </div>
  );
}

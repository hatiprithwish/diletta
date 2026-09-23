import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCreateNote } from "../-data";
import { NoteForm } from "../$noteId/-NoteForm";

export const Route = createFileRoute("/_authenticated/notes/new/")({
  component: NewNotePage,
});

function NewNotePage() {
  const navigate = useNavigate();
  const createNote = useCreateNote();

  return (
    <div className="mx-auto max-w-2xl p-6 flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">New note</h1>
      <NoteForm
        currentTitle="New Note"
        currentBody={null}
        submitLabel="Create note"
        onSubmit={async (value) => {
          await createNote.mutateAsync({ note: value });
          navigate({ to: "/notes" });
        }}
        onCancel={() => navigate({ to: "/notes" })}
      />
    </div>
  );
}

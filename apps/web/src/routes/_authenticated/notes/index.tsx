import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@clerk/tanstack-react-start";
import { NotesQueries } from "./-data";
import { Button } from "@/shadcn/ui/button";
import NoteCard from "./-NoteCard";

export const Route = createFileRoute("/_authenticated/notes/")({
  component: NotesPage,
});

function NotesPage() {
  const { getToken } = useAuth();
  const { data, isPending, isError } = useQuery(NotesQueries.list(getToken));
  const notes = data?.notes ?? [];

  if (isPending) return <div>Loading...</div>;
  if (isError) return <div>Failed to load notes.</div>;

  return (
    <div className="mx-auto max-w-2xl p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Notes</h1>
        <Button asChild>
          <Link to="/notes/new">New note</Link>
        </Button>
      </div>

      {notes.length === 0 ? (
        <p className="text-muted-foreground">No notes yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {notes.map((note) => (
            <NoteCard key={note.publicId} note={note} />
          ))}
        </div>
      )}
    </div>
  );
}

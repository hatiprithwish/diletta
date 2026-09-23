import type * as Schemas from "@app/schemas";

export default function ViewNote({ title, body }: Schemas.NoteBase) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {body && <p className="text-muted-foreground whitespace-pre-wrap">{body}</p>}
    </div>
  );
}

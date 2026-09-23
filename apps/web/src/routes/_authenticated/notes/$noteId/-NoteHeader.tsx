import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/shadcn/ui/button";

interface NoteHeaderProps {
  isEditing: boolean;
  isDeleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export default function NoteHeader({ isEditing, isDeleting, onEdit, onDelete }: NoteHeaderProps) {
  const navigate = useNavigate();

  return (
    <div className="flex items-center justify-between">
      <Button variant="outline" size="sm" onClick={() => navigate({ to: "/notes" })}>
        ← Back
      </Button>
      <div className="flex gap-2">
        {!isEditing && (
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
        )}
        <Button variant="destructive" size="sm" disabled={isDeleting} onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

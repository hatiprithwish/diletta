import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import NoteCard from "@/routes/_authenticated/notes/-NoteCard";

// Mock tanstack-router Link — renders plain anchor in jsdom
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

// Mock react-query mutation used by NoteCard
vi.mock("@/routes/_authenticated/notes/-data", () => ({
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));

const mockNote = {
  id: 1,
  userId: "user_test123",
  title: "Test Note",
  body: "This is the note body.",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("NoteCard", () => {
  it("renders title", () => {
    render(<NoteCard note={mockNote as never} />);
    expect(screen.getByText("Test Note")).toBeInTheDocument();
  });

  it("renders body when present", () => {
    render(<NoteCard note={mockNote as never} />);
    expect(screen.getByText("This is the note body.")).toBeInTheDocument();
  });

  it("renders delete button", () => {
    render(<NoteCard note={mockNote as never} />);
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });

  it("omits body section when body is null", () => {
    render(<NoteCard note={{ ...mockNote, body: null } as never} />);
    expect(screen.queryByText("This is the note body.")).not.toBeInTheDocument();
  });
});

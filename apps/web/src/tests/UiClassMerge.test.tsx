import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Button } from "@app/ui/components/button";
import { cn } from "@app/ui/lib/utils";

// Type-scale tokens (text-body, text-caption, …) must merge as font size, not text colour.
// Components import bare `cn`, so this also proves the vitest/vite alias to packages/ui.
describe("UI class merging", () => {
  it("keeps the colour when a type-scale token is added", () => {
    expect(cn("text-muted-foreground text-body", "text-caption")).toBe(
      "text-muted-foreground text-caption",
    );
  });

  it("replaces a stock font size with a type-scale token", () => {
    expect(cn("text-sm text-foreground", "text-page-title")).toBe(
      "text-foreground text-page-title",
    );
  });

  it("applies the theme-aware merge inside shadcn components", () => {
    render(<Button className="text-caption text-brand-text">Save</Button>);
    const classes = screen.getByRole("button", { name: "Save" }).className.split(" ");
    expect(classes).toContain("text-caption");
    expect(classes).toContain("text-brand-text");
    expect(classes).not.toContain("text-sm");
  });
});

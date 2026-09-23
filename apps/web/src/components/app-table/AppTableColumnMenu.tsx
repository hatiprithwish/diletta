import { EyeSlash } from "@phosphor-icons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shadcn/ui/dropdown-menu";

interface AppTableColumnMenuProps {
  children: React.ReactNode;
  onHide: () => void;
}

export function AppTableColumnMenu({ children, onHide }: AppTableColumnMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={onHide}
          className="gap-2 text-muted-foreground hover:text-foreground"
        >
          <EyeSlash className="h-4 w-4" />
          Hide
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

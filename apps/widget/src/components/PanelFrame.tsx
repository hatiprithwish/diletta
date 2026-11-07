import type { PropsWithChildren } from "react";
import type * as Schemas from "@app/schemas";
import { FULL_SCREEN_FRAME_CLASS, PANEL_FRAME_CLASS, onFrameKeyDown } from "@/lib/panelFrame";

// DEV_NOTE: The open widget's frame around every screen (DESIGN.md §7): a non-modal floating dialog, or a modal one
// filling the window in full screen. Escape closes it.
export default function PanelFrame({
  label,
  isFullScreen,
  onClose,
  children,
}: PropsWithChildren<Schemas.WidgetPanelFrameProps>) {
  return (
    <div
      role="dialog"
      aria-label={label}
      aria-modal={isFullScreen ? true : undefined}
      onKeyDown={onFrameKeyDown({ isFullScreen, onClose })}
      className={isFullScreen ? FULL_SCREEN_FRAME_CLASS : PANEL_FRAME_CLASS}
    >
      {children}
    </div>
  );
}

import type * as Schemas from "@app/schemas";
import PanelFrame from "@/components/PanelFrame";
import PastChatLog from "@/components/PastChatLog";
import SubHeader from "@/components/SubHeader";

// DEV_NOTE: A chat that has ended, in the floating panel (DESIGN.md §7): Back to your chats, its title and line, the
// read-only log, Close.
export default function PastChat({
  onBack,
  onClose,
  onToggleFullScreen,
  ...log
}: Schemas.WidgetPastChatProps) {
  return (
    <PanelFrame label={log.item.title} isFullScreen={false} onClose={onClose}>
      <SubHeader
        title={log.item.title}
        subtitle={log.meta}
        backLabel="Back to your chats"
        onBack={onBack}
        onToggleFullScreen={onToggleFullScreen}
        onClose={onClose}
      />
      <PastChatLog {...log} isWide={false} />
    </PanelFrame>
  );
}

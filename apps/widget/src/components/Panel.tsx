import type * as Schemas from "@app/schemas";
import ChatLog from "@/components/ChatLog";
import Header from "@/components/Header";
import PanelFrame from "@/components/PanelFrame";

// DEV_NOTE: The open widget's chat in the floating panel (DESIGN.md §7): 380 × 680 (smaller on a small screen), the
// header and the chat. A non-modal dialog; Escape closes it.
export default function Panel(props: Schemas.WidgetPanelProps) {
  const { view, onHistory, onNewChat, onToggleFullScreen, onClose } = props;
  return (
    <PanelFrame label={view.chatbotName} isFullScreen={false} onClose={onClose}>
      <Header
        chatbotName={view.chatbotName}
        status={view.status}
        isFullScreen={false}
        onHistory={onHistory}
        onNewChat={onNewChat}
        onToggleFullScreen={onToggleFullScreen}
        onClose={onClose}
      />
      <ChatLog {...props} isWide={false} />
    </PanelFrame>
  );
}

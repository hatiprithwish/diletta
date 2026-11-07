import type * as Schemas from "@app/schemas";
import ChatLog from "@/components/ChatLog";
import Header from "@/components/Header";
import HistoryList from "@/components/HistoryList";
import PanelFrame from "@/components/PanelFrame";
import PastChatLog from "@/components/PastChatLog";

// DEV_NOTE: The widget in full screen (DESIGN.md §7): one header (Exit full screen, Close), Your chats as a 280px
// sidebar, and beside it the chat or the past chat picked there, in a centred column. A modal dialog filling the
// window; Escape closes it.
export default function FullScreenPanel({
  panel,
  history,
  past,
}: Schemas.WidgetFullScreenPanelProps) {
  return (
    <PanelFrame label={panel.view.chatbotName} isFullScreen onClose={panel.onClose}>
      <Header
        chatbotName={panel.view.chatbotName}
        status={panel.view.status}
        isFullScreen
        onHistory={panel.onHistory}
        onNewChat={panel.onNewChat}
        onToggleFullScreen={panel.onToggleFullScreen}
        onClose={panel.onClose}
      />
      <div className="flex min-h-0 grow">
        <aside className="flex w-70 shrink-0 flex-col border-r border-border bg-sidebar pt-4">
          <HistoryList {...history} />
        </aside>
        <main className="flex min-w-0 grow flex-col">
          {past ? <PastChatLog {...past} isWide /> : <ChatLog {...panel} isWide />}
        </main>
      </div>
    </PanelFrame>
  );
}

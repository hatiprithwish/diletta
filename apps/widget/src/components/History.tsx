import * as Schemas from "@app/schemas";
import HistoryList from "@/components/HistoryList";
import PanelFrame from "@/components/PanelFrame";
import SubHeader from "@/components/SubHeader";

// DEV_NOTE: Your chats in the floating panel (DESIGN.md §7): Back to chat, the list, Close. The chat on screen is the
// selected row.
export default function History({
  onBack,
  onClose,
  onToggleFullScreen,
  ...list
}: Schemas.WidgetHistoryProps) {
  const selected =
    list.view.status === "ready"
      ? list.view.groups
          .flatMap((group) => group.rows)
          .find((row) => row.tone === Schemas.WidgetHistoryToneEnum.Current)
      : undefined;
  return (
    <PanelFrame label={list.chatbotName} isFullScreen={false} onClose={onClose}>
      <SubHeader
        title="Your chats"
        subtitle={null}
        backLabel="Back to chat"
        onBack={onBack}
        onToggleFullScreen={onToggleFullScreen}
        onClose={onClose}
      />
      <HistoryList {...list} onBack={onBack} selectedPublicId={selected?.item.publicId ?? null} />
    </PanelFrame>
  );
}

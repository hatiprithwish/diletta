import type * as Schemas from "@app/schemas";

export default function UserBubble({ text }: Schemas.WidgetUserBubbleProps) {
  return (
    <div className="max-w-4/5 self-end rounded-[16px] bg-bubble px-3.25 py-2.25 text-sm leading-snug whitespace-pre-wrap break-words">
      {text}
    </div>
  );
}

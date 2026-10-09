import z from "zod";

// DEV_NOTE: Query of the widget's WebSocket upgrade (GET /widget/ws). chatbot is the embed's chatbot publicId; without
// it the company's default chatbot answers. It only picks a chatbot inside the company the verified token's issuer
// resolves to, so it can't reach another company's chatbot. conversation is the publicId of a conversation to resume
// (after a reload); without it a new conversation starts. The companion JWT is never here: it rides in
// Sec-WebSocket-Protocol (WIDGET_SUBPROTOCOL).
export const ZWidgetConnectApiRequest = z.object({
  chatbot: z.string().trim().min(1).max(64).optional(),
  conversation: z.string().trim().min(1).max(64).optional(),
});
export type WidgetConnectApiRequest = z.infer<typeof ZWidgetConnectApiRequest>;

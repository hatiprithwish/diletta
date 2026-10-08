import z from "zod";

// DEV_NOTE: Query of the widget's WebSocket upgrade (GET /widget/ws). chatbot is the embed's chatbot publicId;
// without it the company's default chatbot answers. It only picks a chatbot inside the company the verified
// token's issuer resolves to, so it can't reach another company's chatbot.
export const ZWidgetConnectApiRequest = z.object({
  chatbot: z.string().trim().min(1).optional(),
});
export type WidgetConnectApiRequest = z.infer<typeof ZWidgetConnectApiRequest>;

// DEV_NOTE: The first WebSocket message: the companion JWT, never in the URL (URLs land in logs and history).
export const ZWidgetAuthMessage = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});
export type WidgetAuthMessage = z.infer<typeof ZWidgetAuthMessage>;

// DEV_NOTE: Every message the widget may send. The Conversation DO (M2-2) adds the chat messages to this union;
// anything that doesn't parse gets an error message back.
export const ZWidgetClientMessage = z.discriminatedUnion("type", [ZWidgetAuthMessage]);
export type WidgetClientMessage = z.infer<typeof ZWidgetClientMessage>;

import { z } from "zod";

// DEV_NOTE: Query of GET /widget/bootstrap (M2-7): the embed's chatbot publicId, as for the socket (absent = the
// company's default chatbot). The companion JWT rides in Authorization: Bearer, never here.
export const ZWidgetBootstrapApiRequest = z.object({
  chatbot: z.string().trim().min(1).max(64).optional(),
});
export type WidgetBootstrapApiRequest = z.infer<typeof ZWidgetBootstrapApiRequest>;

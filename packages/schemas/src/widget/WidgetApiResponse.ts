import { z } from "zod";
import type { ApiResponse } from "../common";
import type { WidgetAuthFailureEnum } from "../widgetAuth";

// DEV_NOTE: GET /widget/bootstrap (M2-7): what the widget shows before any conversation exists, so opening the panel
// never creates one. The chatbot's name, and its widget settings from the published config (greeting, up to 3
// suggestions, the launcher label). widget is null when the chatbot has no loadable published config: the widget
// shows its unavailable state. Client-facing: publicId and names only.
export const ZWidgetBootstrap = z.object({
  chatbot: z.object({ publicId: z.string(), name: z.string() }),
  widget: z
    .object({
      greeting: z.string(),
      suggestions: z.array(z.string()),
      launcherLabel: z.string().nullable(),
    })
    .nullable(),
});
export type WidgetBootstrap = z.infer<typeof ZWidgetBootstrap>;

export const ZWidgetBootstrapApiResponse = z.object({
  isSuccess: z.boolean(),
  message: z.string().optional(),
  bootstrap: ZWidgetBootstrap.optional(),
});
export type WidgetBootstrapApiResponse = z.infer<typeof ZWidgetBootstrapApiResponse>;

// DEV_NOTE: Server-side only (WidgetBootstrapRepo → widget route). isSuccess false always comes with a failure, which
// the route maps to an HTTP status like the socket's.
export interface WidgetBootstrapResponse extends ApiResponse {
  bootstrap?: WidgetBootstrap;
  failure?: WidgetAuthFailureEnum;
}

import { z } from "zod";
import { ToolSchemaChangeEnum } from "./ToolContractsCommon";

// DEV_NOTE: A tool whose schema the app's spec changed, as a chatbot hears of it (ADR 0009): the Tool update issue's
// events carry these (tool names and version numbers, never a value), and its note says it in words.
export const ZToolUpdateEntry = z.object({
  name: z.string().min(1).max(100),
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  change: z.enum(ToolSchemaChangeEnum),
});
export type ToolUpdateEntry = z.infer<typeof ZToolUpdateEntry>;

export const ZToolUpdateDetail = z.object({ tools: z.array(ZToolUpdateEntry).min(1) });
export type ToolUpdateDetail = z.infer<typeof ZToolUpdateDetail>;

// What happened to the chatbot's setup: a new draft copied from the live one, the open draft changed, or nothing
// (the open version is in testing or ready, which only an admin moves back)
export enum ToolUpdateDraftEnum {
  Created = "created",
  Updated = "updated",
  Untouched = "untouched",
}

const NOTE_NAMES_MAX = 6;

export function toolUpdateNote(tools: ToolUpdateEntry[], draft: ToolUpdateDraftEnum): string {
  const names = tools.slice(0, NOTE_NAMES_MAX).map((tool) => tool.name);
  const more = tools.length - names.length;
  const isBreaking = tools.some((tool) => tool.change === ToolSchemaChangeEnum.Breaking);
  const what = `Your app changed ${tools.length === 1 ? "a tool" : `${tools.length} tools`} this chatbot uses: ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`;
  const risk = isBreaking
    ? " Some changes can break calls the chatbot makes today, so check them before you publish."
    : "";
  const next =
    draft === ToolUpdateDraftEnum.Untouched
      ? " The setup being tested still uses the old versions: send it back to draft to update them."
      : draft === ToolUpdateDraftEnum.Created
        ? " A new draft uses the new versions: review it, send it to testing, then publish."
        : " The open draft now uses the new versions: send it to testing, then publish.";
  return `${what}${risk}${next}`;
}

import { z } from "zod";
import {
  ToolDefinitionStatusIntEnum,
  ZToolDefinitionBase,
  ZToolDefinitionName,
  ZToolDefinitionSortColumn,
  getToolRiskOpsIssue,
} from "./ToolDefinitionsCommon";
import { ZPageApiRequest } from "../common";

export const ZCreateToolDefinitionApiRequest = z.object({
  toolDefinition: ZToolDefinitionBase.superRefine((body, ctx) => {
    const issue = getToolRiskOpsIssue(body.risk, body.idempotencyMode, body.ops);
    if (issue) ctx.addIssue({ code: "custom", message: issue, path: ["ops"] });
  }),
});
export type CreateToolDefinitionApiRequest = z.infer<typeof ZCreateToolDefinitionApiRequest>;

// DEV_NOTE: Edits a Draft only. The name never changes (it is the tool's identity across versions); ops are replaced
// as one unit. The risk rule is checked by the Repo on the merged row, since risk, idempotency mode and ops may
// come separately.
export const ZUpdateToolDefinitionApiRequest = z.object({
  toolDefinition: ZToolDefinitionBase.omit({ name: true })
    .partial()
    .refine((body) => Object.values(body).some((value) => value !== undefined), {
      message: "Nothing to update",
    }),
});
export type UpdateToolDefinitionApiRequest = z.infer<typeof ZUpdateToolDefinitionApiRequest>;

// DEV_NOTE: Draft → Active, Active → Disabled, Disabled → Active. Draft is where a version starts, never a target.
export const ZSetToolDefinitionStatusApiRequest = z.object({
  status: z.union([
    z.literal(ToolDefinitionStatusIntEnum.Active),
    z.literal(ToolDefinitionStatusIntEnum.Disabled),
  ]),
});
export type SetToolDefinitionStatusApiRequest = z.infer<typeof ZSetToolDefinitionStatusApiRequest>;

// DEV_NOTE: Every version of every tool, paged. name narrows it to one tool's versions, status to one status
// (query strings, so the status int is coerced).
export const ZGetToolDefinitionsApiRequest = ZPageApiRequest.extend({
  sortColumn: ZToolDefinitionSortColumn.nullable().optional(),
  name: ZToolDefinitionName.nullable().optional(),
  status: z.coerce.number().pipe(z.enum(ToolDefinitionStatusIntEnum)).nullable().optional(),
});
export type GetToolDefinitionsApiRequest = z.infer<typeof ZGetToolDefinitionsApiRequest>;

export const ZGetToolDefinitionsCountApiRequest = ZGetToolDefinitionsApiRequest.pick({
  name: true,
  status: true,
});
export type GetToolDefinitionsCountApiRequest = z.infer<typeof ZGetToolDefinitionsCountApiRequest>;

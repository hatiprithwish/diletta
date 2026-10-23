import { z } from "zod";
import { ZToolDefinitionName } from "../toolDefinitions/ToolDefinitionsCommon";

// DEV_NOTE: Minutes a task takes a person by hand, entered by the company (M4-3, Impact). Rows are never edited: a new
// value is a new row effective from its day, so the hours saved on earlier days keep the minutes they had. A task is
// a write tool (tool:<name>, its verified changes) or answers (conversations answered without a person).

export const ROI_ANSWERS_TASK_TYPE = "answers";
export const ROI_ANSWERS_TASK_LABEL = "Answer how-to questions";
const ROI_TOOL_TASK_PREFIX = "tool:";

// DEV_NOTE: Up to a working day per task, in steps of a tenth of a minute
export const ROI_MANUAL_MINUTES_MAX = 480;

export function roiToolTaskType(toolName: string): string {
  return `${ROI_TOOL_TASK_PREFIX}${toolName}`;
}

// The tool a task type names, or null for answers / anything else
export function roiTaskToolName(taskType: string): string | null {
  return taskType.startsWith(ROI_TOOL_TASK_PREFIX)
    ? taskType.slice(ROI_TOOL_TASK_PREFIX.length)
    : null;
}

export const ZRoiTaskType = z.union([
  z.literal(ROI_ANSWERS_TASK_TYPE),
  z
    .string()
    .startsWith(ROI_TOOL_TASK_PREFIX)
    .refine((taskType) => ZToolDefinitionName.safeParse(roiTaskToolName(taskType)).success, {
      message: "Invalid tool name",
    }),
]);

export const ZRoiManualMinutes = z
  .number()
  .min(0)
  .max(ROI_MANUAL_MINUTES_MAX)
  .refine((minutes) => Math.abs(minutes * 10 - Math.round(minutes * 10)) < 1e-9, {
    message: "At most one decimal place",
  });

// Create Roi Assumption Body
export const ZRoiAssumptionBase = z.object({
  taskType: ZRoiTaskType,
  manualMinutes: ZRoiManualMinutes,
});
export type RoiAssumptionBase = z.infer<typeof ZRoiAssumptionBase>;

// Whole Roi Assumption Body — DB shape (manual_minutes is numeric: an exact decimal string)
// DEV_NOTE: id, companyId and createdBy are internal bigint ids — used by DAL/Repo only, NEVER sent to a client
export const ZRoiAssumption = z.object({
  id: z.string(),
  publicId: z.string(),
  companyId: z.string(),
  taskType: z.string(),
  manualMinutes: z.string(),
  effectiveFrom: z.iso.date(),
  createdBy: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type RoiAssumption = z.infer<typeof ZRoiAssumption>;

// API response shape — internal ids structurally omitted, publicId is client-facing
export type RoiAssumptionView = Omit<RoiAssumption, "id" | "companyId" | "createdBy">;

// DEV_NOTE: Which row holds a task's minutes on a day: the newest row in force (effectiveFrom on or before the day,
// latest effectiveFrom, then latest created). Before the first row, the first row applies, so minutes set today also
// value the work already done. rows: one task's rows, any order.
export function roiMinutesOnDay(
  rows: Pick<RoiAssumption, "manualMinutes" | "effectiveFrom" | "createdAt">[],
  day: string,
): string | null {
  const ordered = [...rows].sort(
    (a, b) =>
      a.effectiveFrom.localeCompare(b.effectiveFrom) ||
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  let found: string | null = ordered[0]?.manualMinutes ?? null;
  for (const row of ordered) {
    if (row.effectiveFrom > day) break;
    found = row.manualMinutes;
  }
  return found;
}

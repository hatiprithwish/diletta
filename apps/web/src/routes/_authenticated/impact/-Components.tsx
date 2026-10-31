import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { PencilSimple } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Button } from "@app/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@app/ui/components/dialog";
import { Field, FieldError, FieldLabel } from "@app/ui/components/field";
import { Input } from "@app/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@app/ui/components/table";
import { BarChart } from "@/components/bar-chart";
import { MetricCell, MetricStrip } from "@/components/metric-strip";
import { SectionHeader } from "@/components/section-header";
import Utilities from "@/utils";
import { useCreateRoiAssumption } from "./-data";

const Tone = Schemas.DashboardToneEnum;

const MONTH_FORMAT = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });

// "this month" / "last month" / "the last 90 days", and what it is compared with
function rangeWords(range: Schemas.ImpactRangeEnum, previousFromDay: string) {
  const previousMonth = MONTH_FORMAT.format(new Date(`${previousFromDay}T00:00:00.000Z`));
  if (range === Schemas.ImpactRangeEnum.ThisMonth) {
    return { period: "this month", comparedWith: `vs same days of ${previousMonth}` };
  }
  if (range === Schemas.ImpactRangeEnum.LastMonth) {
    return { period: "last month", comparedWith: `vs ${previousMonth}` };
  }
  return { period: "in 90 days", comparedWith: "vs the 90 days before" };
}

export function ImpactMetrics({ impact, range }: Schemas.DashboardImpactMetricsProps) {
  const words = rangeWords(range, impact.previous.fromDay);
  const change = Utilities.formatChange(impact.hoursSaved.value, impact.hoursSaved.previousValue);
  const delta = impact.hoursSaved.value - impact.hoursSaved.previousValue;

  return (
    <MetricStrip>
      <MetricCell
        label={`Time saved ${words.period}`}
        value={Utilities.formatHours(impact.hoursSaved.value)}
        note={change ? `${change} ${words.comparedWith}` : undefined}
        noteTone={delta > 0 ? Tone.Positive : delta < 0 ? Tone.Negative : Tone.Neutral}
      />
      <MetricCell
        label="Tasks done"
        value={Utilities.formatCount(impact.tasksDone)}
        note="Verified changes and answered questions"
      />
      <MetricCell
        label="Per working day"
        value={
          impact.hoursPerWorkingDay === null
            ? "—"
            : Utilities.formatHours(impact.hoursPerWorkingDay)
        }
        note={`Across ${Utilities.plural(impact.workingDays, "working day")}, Monday to Friday`}
      />
    </MetricStrip>
  );
}

export function HoursPerWeek({ impact }: Schemas.DashboardImpactSectionProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader title="Hours saved per week" />
      <BarChart
        ariaLabel="Hours saved per week"
        data={impact.hoursPerWeek.map((week) => ({
          key: week.weekStartDay,
          label: `Week of ${Utilities.formatDay(week.weekStartDay)}`,
          value: week.hours,
          valueLabel: Utilities.formatHours(week.hours),
        }))}
      />
    </section>
  );
}

const HEAD_CLASS = "h-auto px-4 py-3 text-caption font-normal text-muted-foreground";
const CELL_CLASS = "px-4 py-[13px] text-body";

export function ByTask({ impact }: Schemas.DashboardImpactSectionProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader
        title="By task"
        description="Minutes per task are entered by your team. Edit them to match how long the work takes by hand."
      />
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD_CLASS}>Task</TableHead>
              <TableHead className={`${HEAD_CLASS} text-right`}>Done by the assistant</TableHead>
              <TableHead className={`${HEAD_CLASS} text-right`}>Your time per task</TableHead>
              <TableHead className={`${HEAD_CLASS} text-right`}>Time saved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {impact.tasks.map((task) => (
              <TableRow key={task.taskType}>
                <TableCell className={CELL_CLASS}>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-foreground">{task.label}</span>
                    {task.toolName && (
                      <span className="font-mono text-mono-value text-muted-foreground">
                        {task.toolName}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell className={`${CELL_CLASS} text-right`}>
                  {Utilities.formatCount(task.count)}
                </TableCell>
                <TableCell className={`${CELL_CLASS} text-right`}>
                  <RoiEditDialog task={task} />
                </TableCell>
                <TableCell className={`${CELL_CLASS} text-right font-medium`}>
                  {Utilities.formatHours(task.hoursSaved)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function minutesIssue(value: string): string | undefined {
  if (value.trim() === "") return "Enter the minutes.";
  return Schemas.ZRoiManualMinutes.safeParse(Number(value)).success
    ? undefined
    : `Enter 0 to ${Schemas.ROI_MANUAL_MINUTES_MAX} minutes, with at most one decimal.`;
}

// DEV_NOTE: A task's minutes per task. A save adds a new value in force from today: earlier days keep their minutes,
// except on a task's first save, whose value also covers the days before it (roiMinutesOnDay)
function RoiEditDialog({ task }: Schemas.DashboardRoiEditProps) {
  const [isOpen, setIsOpen] = useState(false);
  const createRoiAssumption = useCreateRoiAssumption();
  const form = useForm({
    defaultValues: {
      manualMinutes: task.manualMinutes === null ? "" : String(Number(task.manualMinutes)),
    },
    onSubmit: async ({ value }) => {
      await createRoiAssumption.mutateAsync({
        taskType: task.taskType,
        manualMinutes: Number(value.manualMinutes),
      });
      setIsOpen(false);
    },
  });

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (open) form.reset();
      }}
    >
      <DialogTrigger asChild>
        {task.manualMinutes === null ? (
          <Button variant="ghost" size="sm" className="text-brand-text">
            Set time
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-foreground"
            aria-label={`Edit time per task for ${task.label}`}
          >
            {Number(task.manualMinutes)} min
            <PencilSimple className="text-subtle-foreground" aria-hidden />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit().catch(() => undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>Time per task</DialogTitle>
            <DialogDescription>
              How long “{task.label}” takes a person by hand.{" "}
              {task.manualMinutes === null
                ? "This time also counts for earlier days, until you change it."
                : "The new time counts from today; earlier days keep the time they had."}
            </DialogDescription>
          </DialogHeader>
          <form.Field
            name="manualMinutes"
            validators={{ onChange: ({ value }) => minutesIssue(value) }}
          >
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0}>
                <FieldLabel htmlFor={field.name}>Minutes</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  inputMode="decimal"
                  autoFocus
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  aria-invalid={field.state.meta.errors.length > 0}
                />
                <FieldError
                  errors={field.state.meta.errors.map((message) => ({ message: String(message) }))}
                />
              </Field>
            )}
          </form.Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button type="submit" disabled={!canSubmit || isSubmitting}>
                  {isSubmitting ? "Saving…" : "Save"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

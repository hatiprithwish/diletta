import { Link } from "@tanstack/react-router";
import type { PropsWithChildren } from "react";
import { CaretRight, FileText, Flag, Flask, Warning } from "@phosphor-icons/react";
import * as Schemas from "@app/schemas";
import { Badge } from "@app/ui/components/badge";
import { Button } from "@app/ui/components/button";
import { Progress } from "@app/ui/components/progress";
import { BarChart } from "@/components/bar-chart";
import { MetricCell, MetricStrip } from "@/components/metric-strip";
import { SectionHeader } from "@/components/section-header";
import Utilities from "@/utils";

const Tone = Schemas.DashboardToneEnum;

function toneOf(change: number): Schemas.DashboardToneEnum {
  return change > 0 ? Tone.Positive : change < 0 ? Tone.Negative : Tone.Neutral;
}

export function OverviewMetrics({ overview }: Schemas.DashboardOverviewSectionProps) {
  const { conversations, answeredRate, helpfulRate, changes } = overview;
  const conversationsChange = Utilities.formatChange(
    conversations.value,
    conversations.previousValue,
  );
  const answeredChange = Utilities.formatPointsChange(
    answeredRate.value,
    answeredRate.previousValue,
  );

  return (
    <MetricStrip>
      <MetricCell
        label="Conversations"
        value={Utilities.formatCount(conversations.value)}
        note={conversationsChange ? `${conversationsChange} vs last period` : undefined}
        noteTone={toneOf(conversations.value - conversations.previousValue)}
      />
      <MetricCell
        label="Answered without handoff"
        value={Utilities.formatRate(answeredRate.value)}
        note={answeredChange ?? undefined}
        noteTone={toneOf((answeredRate.value ?? 0) - (answeredRate.previousValue ?? 0))}
      />
      <MetricCell
        label="Helpful replies"
        value={Utilities.formatRate(helpfulRate.value)}
        note={`${Utilities.formatCount(helpfulRate.ratedCount)} rated`}
      />
      <MetricCell
        label="Changes verified"
        value={Utilities.formatCount(changes.verified)}
        note={`${Utilities.formatCount(changes.undone)} undone, ${Utilities.formatCount(changes.needsHuman)} ${changes.needsHuman === 1 ? "needs" : "need"} a person`}
      />
    </MetricStrip>
  );
}

export function ConversationsPerDay({ overview }: Schemas.DashboardOverviewSectionProps) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader title="Conversations per day" />
      <BarChart
        ariaLabel="Conversations per day"
        data={overview.conversationsPerDay.map((day) => ({
          key: day.day,
          label: Utilities.formatDay(day.day),
          value: day.value,
          valueLabel: Utilities.plural(day.value, "conversation"),
        }))}
      />
    </section>
  );
}

// DEV_NOTE: The billing month's spend against the company budget (DESIGN.md §5 budget bar: ticks at 50% and 80%)
export function MonthSpend({ overview }: Schemas.DashboardOverviewSectionProps) {
  const { monthSpend } = overview;
  const budget = Number(monthSpend.budgetUsd);
  const percent = budget > 0 ? Math.min(100, (Number(monthSpend.spentUsd) / budget) * 100) : 0;

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader title="Spend this period">
        <Link to="/usage" className="text-caption text-brand-text hover:text-foreground">
          Usage
        </Link>
      </SectionHeader>
      <div className="flex flex-col gap-4 rounded-xl border px-[22px] py-5">
        <p className="flex items-baseline gap-2">
          <span className="text-metric text-foreground">
            {Utilities.formatUsd(monthSpend.spentUsd)}
          </span>
          <span className="text-caption text-muted-foreground">
            of {Utilities.formatUsd(monthSpend.budgetUsd)}
          </span>
        </p>
        <div className="relative">
          <Progress value={percent} aria-label="Budget used" />
          <span
            className="absolute inset-y-[-4px] left-1/2 w-px bg-subtle-foreground"
            aria-hidden
          />
          <span
            className="absolute inset-y-[-4px] left-4/5 w-px bg-subtle-foreground"
            aria-hidden
          />
        </div>
        <div className="flex justify-between gap-3 text-caption text-muted-foreground">
          <span>Since {Utilities.formatDay(monthSpend.fromDay)}</span>
          <span>Resets {Utilities.formatDay(monthSpend.resetsOnDay)}</span>
        </div>
        <p className="text-caption text-subtle-foreground">
          On your own model key. Includes {Utilities.formatUsd(monthSpend.testRunsUsd)} of test
          runs.
        </p>
      </div>
    </section>
  );
}

export function NeedsAttention({ overview }: Schemas.DashboardOverviewSectionProps) {
  const { attention } = overview;
  const isClear =
    attention.needsHumanCount === 0 &&
    attention.openIssueCount === 0 &&
    attention.failedSourceCount === 0;

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader title="Needs attention" />
      <div className="flex flex-col divide-y rounded-xl border px-[22px]">
        {isClear && (
          <p className="py-5 text-body text-muted-foreground">Nothing needs attention.</p>
        )}
        {attention.needsHumanCount > 0 && (
          <AttentionRow
            to="/changes"
            label={`${Utilities.plural(attention.needsHumanCount, "change")} ${attention.needsHumanCount === 1 ? "needs" : "need"} a person`}
          >
            <Warning className="text-destructive" />
          </AttentionRow>
        )}
        {attention.openIssueCount > 0 && (
          <AttentionRow
            to="/quality"
            label={`${Utilities.plural(attention.openIssueCount, "open issue")} to triage`}
            detail={`${Utilities.formatCount(attention.openUserIssueCount)} from users`}
          >
            <Flag className="text-warning" />
          </AttentionRow>
        )}
        {attention.failedSourceCount > 0 && (
          <AttentionRow
            to="/knowledge"
            label={`${Utilities.plural(attention.failedSourceCount, "knowledge source")} failed to sync`}
            detail={
              attention.lastSourceFailedAt
                ? Utilities.formatTimeAgo(attention.lastSourceFailedAt)
                : undefined
            }
          >
            <FileText className="text-subtle-foreground" />
          </AttentionRow>
        )}
      </div>
    </section>
  );
}

function AttentionRow({
  to,
  label,
  detail,
  children,
}: PropsWithChildren<Schemas.DashboardAttentionRowProps>) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 py-4 text-body text-foreground hover:text-brand-text"
    >
      <span className="flex size-4 items-center justify-center" aria-hidden>
        {children}
      </span>
      <span className="flex-1">{label}</span>
      {detail && <span className="text-caption text-muted-foreground">{detail}</span>}
      <CaretRight className="size-3.5 text-muted-foreground" aria-hidden />
    </Link>
  );
}

// DEV_NOTE: The shown bot's live config. Test runs (the publish gate) come with M5; until then the line says so.
export function LiveConfiguration({ overview }: Schemas.DashboardOverviewSectionProps) {
  const { liveConfig } = overview;
  const published = liveConfig?.published ?? null;

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <SectionHeader title="Live configuration" />
      <div className="flex flex-col gap-3 rounded-xl border px-[22px] py-5">
        {liveConfig === null && <p className="text-body text-muted-foreground">No bot yet.</p>}
        {liveConfig !== null && published === null && (
          <>
            <p className="text-section text-foreground">{liveConfig.chatbotName}</p>
            <p className="text-body text-subtle-foreground">Not published yet.</p>
          </>
        )}
        {liveConfig !== null && published !== null && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-section text-foreground">
                Version {published.configVersion}
              </span>
              <Badge className="gap-1.5 bg-brand-soft text-brand-text">
                <span className="size-1.5 rounded-full bg-current" aria-hidden />
                Published
              </Badge>
            </div>
            <p className="text-body text-subtle-foreground">
              {[
                liveConfig.chatbotName,
                published.publishedAt &&
                  `Published ${Utilities.formatDay(published.publishedAt.slice(0, 10))}${published.publishedByName ? ` by ${published.publishedByName}` : ""}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="flex items-center gap-2 text-body text-muted-foreground">
              <Flask className="size-3.5" aria-hidden />
              No test run yet
            </p>
          </>
        )}
        <div>
          <Button variant="outline" asChild>
            <Link to="/settings/bots">
              {liveConfig === null ? "Set up a bot" : "Edit configuration"}
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

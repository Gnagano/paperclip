import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue, Project } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { CalendarRange } from "lucide-react";

const DAY_MS = 86_400_000;
const DAY_WIDTH = 56;
const HOURS_PER_DAY = 8;
const SCHEDULE_LABEL = /^\d{6}-(?:w\d+|\d+w)$/i;

function utcDay(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function mondayOnOrBefore(date: Date) {
  const day = date.getUTCDay();
  return addDays(date, -(day === 0 ? 6 : day - 1));
}

function sundayOnOrAfter(date: Date) {
  const day = date.getUTCDay();
  return addDays(date, day === 0 ? 0 : 7 - day);
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shortDate(date: Date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function hours(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value ?? 0);
}

function statusColor(status: Issue["status"]) {
  if (status === "done") return "bg-emerald-500";
  if (status === "blocked") return "bg-red-500";
  if (status === "in_progress") return "bg-blue-500";
  if (status === "in_review") return "bg-violet-500";
  return "bg-slate-400";
}

interface ScheduleGroup {
  name: string;
  issues: Issue[];
}

type TaskSort = "schedule" | "start" | "name";

export interface TaskPlacement {
  startHour: number;
  endHour: number;
}

const PRIORITY_WEIGHT: Record<Issue["priority"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function hasSchedulableEffort(issue: Issue) {
  return Boolean(issue.startDate) && issue.estimatedHours != null && issue.estimatedHours > 0;
}

export function calculateTaskPlacements(issues: Issue[]) {
  const schedulable = issues.filter(hasSchedulableEffort);
  const firstDate = schedulable.map((issue) => issue.startDate!).sort()[0] ?? null;
  const placements = new Map<string, TaskPlacement>();
  if (!firstDate) return { firstDate, placements };

  const remaining = new Map(schedulable.map((issue) => [issue.id, issue]));
  let cursorHour = 0;
  while (remaining.size > 0) {
    const available = [...remaining.values()].filter((issue) =>
      !(issue.blockedBy ?? []).some((blocker) => remaining.has(blocker.id)),
    );
    const candidates = available.length > 0 ? available : [...remaining.values()];
    candidates.sort((left, right) => {
      const dateOrder = left.startDate!.localeCompare(right.startDate!);
      if (dateOrder !== 0) return dateOrder;
      const priorityOrder = PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority];
      if (priorityOrder !== 0) return priorityOrder;
      return (left.title || left.identifier || "").localeCompare(right.title || right.identifier || "", undefined, { sensitivity: "base" });
    });
    const issue = candidates[0]!;
    const plannedStartHour = Math.round((utcDay(issue.startDate!).getTime() - utcDay(firstDate).getTime()) / DAY_MS) * HOURS_PER_DAY;
    const blockerEndHour = Math.max(0, ...(issue.blockedBy ?? []).map((blocker) => placements.get(blocker.id)?.endHour ?? 0));
    const startHour = Math.max(plannedStartHour, cursorHour, blockerEndHour);
    const endHour = startHour + (issue.estimatedHours ?? 0);
    placements.set(issue.id, { startHour, endHour });
    cursorHour = endHour;
    remaining.delete(issue.id);
  }
  return { firstDate, placements };
}

export function sortScheduledTasks(issues: Issue[], sortBy: TaskSort, placements = new Map<string, TaskPlacement>()) {
  return [...issues].sort((left, right) => {
    if (sortBy === "name") {
      return (left.title || left.identifier || "").localeCompare(right.title || right.identifier || "", undefined, { sensitivity: "base" });
    }
    if (sortBy === "schedule") {
      return (placements.get(left.id)?.startHour ?? Number.MAX_SAFE_INTEGER) - (placements.get(right.id)?.startHour ?? Number.MAX_SAFE_INTEGER)
        || PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority]
        || (left.title || left.identifier || "").localeCompare(right.title || right.identifier || "", undefined, { sensitivity: "base" });
    }
    return (left.startDate ?? "9999-12-31").localeCompare(right.startDate ?? "9999-12-31")
      || PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority]
      || (left.title || left.identifier || "").localeCompare(right.title || right.identifier || "", undefined, { sensitivity: "base" });
  });
}

export function buildTaskScheduleGroups(issues: Issue[]): ScheduleGroup[] {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    const names = (issue.labels ?? []).map((label) => label.name).filter((name) => SCHEDULE_LABEL.test(name));
    const groupNames = names.length > 0 ? names : ["Other scheduled tasks"];
    for (const name of groupNames) groups.set(name, [...(groups.get(name) ?? []), issue]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left === "Other scheduled tasks" ? 1 : right === "Other scheduled tasks" ? -1 : left.localeCompare(right))
    .map(([name, groupedIssues]) => ({ name, issues: groupedIssues }));
}

function GroupChart({ group, projects, sortBy }: { group: ScheduleGroup; projects: Map<string, Project>; sortBy: TaskSort }) {
  const schedule = useMemo(() => calculateTaskPlacements(group.issues), [group.issues]);
  const sortedIssues = useMemo(() => sortScheduledTasks(group.issues, sortBy, schedule.placements), [group.issues, schedule.placements, sortBy]);
  const rawStart = schedule.firstDate ?? dateKey(new Date());
  const lastEndHour = Math.max(0, ...[...schedule.placements.values()].map((placement) => placement.endHour));
  const rawEnd = dateKey(addDays(utcDay(rawStart), Math.floor(lastEndHour / HOURS_PER_DAY)));
  const start = mondayOnOrBefore(utcDay(rawStart));
  let end = sundayOnOrAfter(utcDay(rawEnd));
  if ((end.getTime() - start.getTime()) / DAY_MS < 13) end = addDays(start, 13);
  const dayCount = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => addDays(start, index));
  const weeks = Array.from({ length: Math.ceil(dayCount / 7) }, (_, index) => {
    const weekStart = addDays(start, index * 7);
    const weekEnd = addDays(weekStart, 6);
    const total = group.issues.reduce((sum, issue) => {
      const placement = schedule.placements.get(issue.id);
      if (!placement) return sum;
      const taskStart = addDays(utcDay(rawStart), Math.floor(placement.startHour / HOURS_PER_DAY)).getTime();
      return taskStart >= weekStart.getTime() && taskStart <= weekEnd.getTime()
        ? sum + (issue.estimatedHours ?? 0)
        : sum;
    }, 0);
    return { start: weekStart, end: weekEnd, total };
  });
  const chartWidth = dayCount * DAY_WIDTH;

  return (
    <Card className="block overflow-hidden py-0">
      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div className="flex border-b border-border bg-muted/35">
            <div className="sticky left-0 z-20 flex w-[360px] shrink-0 items-center justify-between border-r border-border bg-muted/95 px-4 py-2 backdrop-blur">
              <div>
                <h2 className="text-sm font-semibold">{group.name}</h2>
                <p className="text-xs text-muted-foreground">{group.issues.length} tasks</p>
              </div>
            </div>
            <div className="flex" style={{ width: chartWidth }}>
              {weeks.map((week) => (
                <div key={dateKey(week.start)} className="flex shrink-0 items-center justify-between border-r border-border px-3 py-2 text-xs" style={{ width: DAY_WIDTH * 7 }}>
                  <span className="text-muted-foreground">{shortDate(week.start)} - {shortDate(week.end)}</span>
                  <span className="font-semibold tabular-nums">{hours(week.total)} H</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex h-7 border-b border-border text-[10px] text-muted-foreground">
            <div className="sticky left-0 z-20 w-[360px] shrink-0 border-r border-border bg-card" />
            {days.map((day) => (
              <div key={dateKey(day)} className={`relative flex shrink-0 items-center justify-center border-r border-border/60 ${day.getUTCDay() === 0 || day.getUTCDay() === 6 ? "bg-muted/45" : ""}`} style={{ width: DAY_WIDTH }}>
                <span className="absolute inset-y-0 left-1/2 border-l border-dashed border-border/70" aria-hidden="true" />
                {day.getUTCDate()}
              </div>
            ))}
          </div>
          {sortedIssues.map((issue) => {
            const placement = schedule.placements.get(issue.id);
            const baseOffsetHours = Math.round((utcDay(rawStart).getTime() - start.getTime()) / DAY_MS) * HOURS_PER_DAY;
            const estimatedHours = Math.max(0, issue.estimatedHours ?? 0);
            const workWidth = estimatedHours > 0 ? Math.max(12, estimatedHours / HOURS_PER_DAY * DAY_WIDTH) : 0;
            const project = issue.projectId ? projects.get(issue.projectId) : undefined;
            const missingSchedule = !hasSchedulableEffort(issue);
            return (
              <div key={issue.id} className={`group flex h-14 border-b border-border last:border-b-0 hover:bg-accent/25 ${missingSchedule ? "bg-amber-500/10" : ""}`}>
                <div className={`sticky left-0 z-10 flex w-[360px] shrink-0 items-center border-r border-border px-4 group-hover:bg-accent/95 ${missingSchedule ? "bg-amber-50 dark:bg-amber-950/60" : "bg-card"}`}>
                  <Link to={issueUrl(issue)} className="min-w-0 no-underline text-inherit">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier ?? "Task"}</span>
                      <span className="truncate text-sm font-medium" title={issue.title}>{issue.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="max-w-52 truncate">{project?.name ?? "No project"}</span>
                      <span className="tabular-nums">{issue.startDate ?? "Start missing"}</span>
                      <span className="tabular-nums">{issue.estimatedHours == null ? "Hours missing" : `${hours(issue.estimatedHours)} H`}</span>
                      {missingSchedule ? <span className="font-semibold text-amber-700 dark:text-amber-300">Needs schedule</span> : null}
                    </div>
                  </Link>
                </div>
                <div className="relative h-14" style={{ width: chartWidth }}>
                  {days.map((day, dayIndex) => (
                    <span key={dateKey(day)} className={`absolute inset-y-0 border-r border-border/50 ${day.getUTCDay() === 0 || day.getUTCDay() === 6 ? "bg-muted/35" : ""}`} style={{ left: (dayIndex + 1) * DAY_WIDTH - 1 }}>
                      <span className="absolute inset-y-0 border-l border-dashed border-border/40" style={{ left: -DAY_WIDTH / 2 }} aria-hidden="true" />
                    </span>
                  ))}
                  {placement && workWidth > 0 ? (
                    <Link
                      to={issueUrl(issue)}
                      className={`absolute top-5 flex h-7 items-center rounded px-2 text-xs font-medium text-white shadow-sm no-underline ${statusColor(issue.status)}`}
                      style={{ left: ((baseOffsetHours + placement.startHour) / HOURS_PER_DAY) * DAY_WIDTH + 3, width: workWidth }}
                      title={`${issue.title} · planned ${issue.startDate ?? "—"} · ${hours(issue.estimatedHours)} H · priority ${issue.priority}${issue.dueDate ? ` · due reference ${issue.dueDate}` : ""}`}
                    >
                      <span className={workWidth < 36 ? "sr-only" : "truncate"}>{hours(issue.estimatedHours)} H</span>
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

export function TaskScheduleGantt({ companyId }: { companyId: string }) {
  const [sortBy, setSortBy] = useState<TaskSort>("schedule");
  const issuesQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "issues"],
    queryFn: () => issuesApi.list(companyId, { limit: 500, includeBlockedBy: true }),
  });
  const projectsQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "projects"],
    queryFn: () => projectsApi.list(companyId),
  });
  const groups = useMemo(() => buildTaskScheduleGroups(issuesQuery.data ?? []), [issuesQuery.data]);
  const projectMap = useMemo(() => new Map((projectsQuery.data ?? []).map((project) => [project.id, project])), [projectsQuery.data]);
  const needsSchedule = (issuesQuery.data ?? []).filter((issue) => !hasSchedulableEffort(issue)).length;

  if (issuesQuery.isLoading || projectsQuery.isLoading) return <PageSkeleton />;
  if (issuesQuery.error || projectsQuery.error) return <EmptyState icon={CalendarRange} message="Couldn't load the task schedule." />;
  if (groups.length === 0) return <EmptyState icon={CalendarRange} message="No tasks to schedule." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div>
          <p>Grouped by schedule labels such as 202609-w2 · bars use Start Date + Hours · Due Date is reference only</p>
          <p className={needsSchedule > 0 ? "font-medium text-amber-700 dark:text-amber-300" : undefined}>{needsSchedule} task{needsSchedule === 1 ? "" : "s"} need Start Date and Hours</p>
        </div>
        <div className="flex items-center gap-1" aria-label="Task schedule sort">
          <span className="mr-1">Sort</span>
          <Button type="button" size="sm" variant={sortBy === "schedule" ? "secondary" : "ghost"} onClick={() => setSortBy("schedule")}>Schedule</Button>
          <Button type="button" size="sm" variant={sortBy === "start" ? "secondary" : "ghost"} onClick={() => setSortBy("start")}>Start Date</Button>
          <Button type="button" size="sm" variant={sortBy === "name" ? "secondary" : "ghost"} onClick={() => setSortBy("name")}>Task Name</Button>
        </div>
      </div>
      {groups.map((group) => <GroupChart key={group.name} group={group} projects={projectMap} sortBy={sortBy} />)}
    </div>
  );
}

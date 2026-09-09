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

type TaskSort = "start" | "name";

export function sortScheduledTasks(issues: Issue[], sortBy: TaskSort) {
  return [...issues].sort((left, right) => {
    if (sortBy === "name") {
      return (left.title || left.identifier || "").localeCompare(right.title || right.identifier || "", undefined, { sensitivity: "base" });
    }
    return (left.startDate ?? left.dueDate ?? "9999-12-31").localeCompare(right.startDate ?? right.dueDate ?? "9999-12-31")
      || (left.title || left.identifier || "").localeCompare(right.title || right.identifier || "", undefined, { sensitivity: "base" });
  });
}

export function buildTaskScheduleGroups(issues: Issue[]): ScheduleGroup[] {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.startDate && !issue.dueDate) continue;
    const names = (issue.labels ?? []).map((label) => label.name).filter((name) => SCHEDULE_LABEL.test(name));
    const groupNames = names.length > 0 ? names : ["Other scheduled tasks"];
    for (const name of groupNames) groups.set(name, [...(groups.get(name) ?? []), issue]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left === "Other scheduled tasks" ? 1 : right === "Other scheduled tasks" ? -1 : left.localeCompare(right))
    .map(([name, groupedIssues]) => ({ name, issues: groupedIssues }));
}

function GroupChart({ group, projects, sortBy }: { group: ScheduleGroup; projects: Map<string, Project>; sortBy: TaskSort }) {
  const sortedIssues = useMemo(() => sortScheduledTasks(group.issues, sortBy), [group.issues, sortBy]);
  const rawStart = group.issues.reduce((value, issue) => {
    const next = issue.startDate ?? issue.dueDate!;
    return !value || next < value ? next : value;
  }, "");
  const rawEnd = group.issues.reduce((value, issue) => {
    const issueStart = utcDay(issue.startDate ?? issue.dueDate!);
    const hoursEnd = addDays(issueStart, Math.max(0, Math.ceil((issue.estimatedHours ?? 0) / HOURS_PER_DAY) - 1));
    const next = [issue.dueDate ?? issue.startDate!, dateKey(hoursEnd)].sort().at(-1)!;
    return !value || next > value ? next : value;
  }, "");
  const start = mondayOnOrBefore(utcDay(rawStart));
  let end = sundayOnOrAfter(utcDay(rawEnd));
  if ((end.getTime() - start.getTime()) / DAY_MS < 13) end = addDays(start, 13);
  const dayCount = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => addDays(start, index));
  const weeks = Array.from({ length: Math.ceil(dayCount / 7) }, (_, index) => {
    const weekStart = addDays(start, index * 7);
    const weekEnd = addDays(weekStart, 6);
    const total = group.issues.reduce((sum, issue) => {
      const taskStart = utcDay(issue.startDate ?? issue.dueDate!).getTime();
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
            const taskStart = utcDay(issue.startDate ?? issue.dueDate!);
            const taskEnd = new Date(Math.max(taskStart.getTime(), utcDay(issue.dueDate ?? issue.startDate!).getTime()));
            const offset = Math.max(0, Math.round((taskStart.getTime() - start.getTime()) / DAY_MS));
            const dateDuration = Math.max(1, Math.round((taskEnd.getTime() - taskStart.getTime()) / DAY_MS) + 1);
            const estimatedHours = Math.max(0, issue.estimatedHours ?? 0);
            const workWidth = estimatedHours > 0 ? Math.max(12, estimatedHours / HOURS_PER_DAY * DAY_WIDTH) : 0;
            const project = issue.projectId ? projects.get(issue.projectId) : undefined;
            return (
              <div key={issue.id} className="group flex h-14 border-b border-border last:border-b-0 hover:bg-accent/25">
                <div className="sticky left-0 z-10 flex w-[360px] shrink-0 items-center border-r border-border bg-card px-4 group-hover:bg-accent/95">
                  <Link to={issueUrl(issue)} className="min-w-0 no-underline text-inherit">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier ?? "Task"}</span>
                      <span className="truncate text-sm font-medium" title={issue.title}>{issue.title}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="max-w-52 truncate">{project?.name ?? "No project"}</span>
                      <span className="tabular-nums">{hours(issue.estimatedHours)} H</span>
                    </div>
                  </Link>
                </div>
                <div className="relative h-14" style={{ width: chartWidth }}>
                  {days.map((day, dayIndex) => (
                    <span key={dateKey(day)} className={`absolute inset-y-0 border-r border-border/50 ${day.getUTCDay() === 0 || day.getUTCDay() === 6 ? "bg-muted/35" : ""}`} style={{ left: (dayIndex + 1) * DAY_WIDTH - 1 }}>
                      <span className="absolute inset-y-0 border-l border-dashed border-border/40" style={{ left: -DAY_WIDTH / 2 }} aria-hidden="true" />
                    </span>
                  ))}
                  <span className="absolute top-2 h-px bg-foreground/45" style={{ left: offset * DAY_WIDTH + DAY_WIDTH / 2, width: Math.max(0, (dateDuration - 1) * DAY_WIDTH) }} aria-hidden="true">
                    <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full border border-foreground/60 bg-card" />
                    <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full border border-foreground/60 bg-card" />
                  </span>
                  {workWidth > 0 ? (
                    <Link
                      to={issueUrl(issue)}
                      className={`absolute top-5 flex h-7 items-center rounded px-2 text-xs font-medium text-white shadow-sm no-underline ${statusColor(issue.status)}`}
                      style={{ left: offset * DAY_WIDTH + 3, width: workWidth }}
                      title={`${issue.title} · ${issue.startDate ?? "—"} - ${issue.dueDate ?? "—"} · ${hours(issue.estimatedHours)} H`}
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
  const [sortBy, setSortBy] = useState<TaskSort>("start");
  const issuesQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "issues"],
    queryFn: () => issuesApi.list(companyId, { limit: 500 }),
  });
  const projectsQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "projects"],
    queryFn: () => projectsApi.list(companyId),
  });
  const groups = useMemo(() => buildTaskScheduleGroups(issuesQuery.data ?? []), [issuesQuery.data]);
  const projectMap = useMemo(() => new Map((projectsQuery.data ?? []).map((project) => [project.id, project])), [projectsQuery.data]);
  const omitted = (issuesQuery.data ?? []).filter((issue) => !issue.startDate && !issue.dueDate).length;

  if (issuesQuery.isLoading || projectsQuery.isLoading) return <PageSkeleton />;
  if (issuesQuery.error || projectsQuery.error) return <EmptyState icon={CalendarRange} message="Couldn't load the task schedule." />;
  if (groups.length === 0) return <EmptyState icon={CalendarRange} message="Add a Start Date or Due Date to a task to show it here." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div>
          <p>Grouped by schedule labels such as 202609-w2 · line = Start–Due · bar = estimated Hours from Start</p>
          <p>{omitted} task{omitted === 1 ? "" : "s"} without dates omitted</p>
        </div>
        <div className="flex items-center gap-1" aria-label="Task schedule sort">
          <span className="mr-1">Sort</span>
          <Button type="button" size="sm" variant={sortBy === "start" ? "secondary" : "ghost"} onClick={() => setSortBy("start")}>Start Date</Button>
          <Button type="button" size="sm" variant={sortBy === "name" ? "secondary" : "ghost"} onClick={() => setSortBy("name")}>Task Name</Button>
        </div>
      </div>
      {groups.map((group) => <GroupChart key={group.name} group={group} projects={projectMap} sortBy={sortBy} />)}
    </div>
  );
}

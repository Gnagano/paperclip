import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue, Project } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { CalendarRange } from "lucide-react";

const DAY_MS = 86_400_000;
const DAY_WIDTH = 48;
const SCHEDULE_LABEL = /^\d{6}-\d+w$/i;

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
    .map(([name, groupedIssues]) => ({
      name,
      issues: groupedIssues.sort((left, right) =>
        (left.startDate ?? left.dueDate ?? "").localeCompare(right.startDate ?? right.dueDate ?? "")
        || (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title)),
    }));
}

function GroupChart({ group, projects }: { group: ScheduleGroup; projects: Map<string, Project> }) {
  const rawStart = group.issues.reduce((value, issue) => {
    const next = issue.startDate ?? issue.dueDate!;
    return !value || next < value ? next : value;
  }, "");
  const rawEnd = group.issues.reduce((value, issue) => {
    const next = issue.dueDate ?? issue.startDate!;
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
                <div key={dateKey(week.start)} className="flex w-[336px] shrink-0 items-center justify-between border-r border-border px-3 py-2 text-xs">
                  <span className="text-muted-foreground">{shortDate(week.start)} - {shortDate(week.end)}</span>
                  <span className="font-semibold tabular-nums">{hours(week.total)} H</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex h-7 border-b border-border text-[10px] text-muted-foreground">
            <div className="sticky left-0 z-20 w-[360px] shrink-0 border-r border-border bg-card" />
            {days.map((day) => (
              <div key={dateKey(day)} className={`flex w-12 shrink-0 items-center justify-center border-r border-border/60 ${day.getUTCDay() === 0 || day.getUTCDay() === 6 ? "bg-muted/45" : ""}`}>
                {day.getUTCDate()}
              </div>
            ))}
          </div>
          {group.issues.map((issue) => {
            const taskStart = utcDay(issue.startDate ?? issue.dueDate!);
            const taskEnd = utcDay(issue.dueDate ?? issue.startDate!);
            const offset = Math.max(0, Math.round((taskStart.getTime() - start.getTime()) / DAY_MS));
            const duration = Math.max(1, Math.round((taskEnd.getTime() - taskStart.getTime()) / DAY_MS) + 1);
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
                  {days.map((day) => (
                    <span key={dateKey(day)} className={`absolute inset-y-0 border-r border-border/50 ${day.getUTCDay() === 0 || day.getUTCDay() === 6 ? "bg-muted/35" : ""}`} style={{ left: (days.indexOf(day) + 1) * DAY_WIDTH - 1 }} />
                  ))}
                  <Link
                    to={issueUrl(issue)}
                    className={`absolute top-3 flex h-8 items-center overflow-hidden rounded px-2 text-xs font-medium text-white shadow-sm no-underline ${statusColor(issue.status)}`}
                    style={{ left: offset * DAY_WIDTH + 3, width: duration * DAY_WIDTH - 6 }}
                    title={`${issue.title} · ${issue.startDate ?? "—"} - ${issue.dueDate ?? "—"} · ${hours(issue.estimatedHours)} H`}
                  >
                    <span className="truncate">{hours(issue.estimatedHours)} H</span>
                  </Link>
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>Grouped by schedule labels such as 202609-1w · bars show Start Date through Due Date</p>
        <p>{omitted} task{omitted === 1 ? "" : "s"} without dates omitted</p>
      </div>
      {groups.map((group) => <GroupChart key={group.name} group={group} projects={projectMap} />)}
    </div>
  );
}

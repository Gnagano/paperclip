import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue, Project } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { accessApi } from "@/api/access";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
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
const SCHEDULE_LABEL = /^\d{6}-(?:[ws]\d+|\d+[ws])$/i;
const BACKLOG_GROUP = "Backlog";

function assigneeKey(issue: Issue) {
  if (issue.assigneeUserId) return `user:${issue.assigneeUserId}`;
  if (issue.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
  return "unassigned";
}

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

function todayUtc() {
  const today = new Date();
  return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

function isWeekend(date: Date) {
  return date.getUTCDay() === 0 || date.getUTCDay() === 6;
}

function nextWorkingDay(date: Date) {
  let result = date;
  while (isWeekend(result)) result = addDays(result, 1);
  return result;
}

function capacityHoursBetween(start: Date, end: Date, skipWeekends: boolean) {
  let hours = 0;
  for (let day = start; day < end; day = addDays(day, 1)) {
    if (!skipWeekends || !isWeekend(day)) hours += HOURS_PER_DAY;
  }
  return hours;
}

export function calendarPointForCapacityHour(start: Date, hour: number, skipWeekends: boolean) {
  let day = skipWeekends ? nextWorkingDay(start) : start;
  let wholeDays = Math.floor(hour / HOURS_PER_DAY);
  while (wholeDays > 0) {
    day = addDays(day, 1);
    if (!skipWeekends || !isWeekend(day)) wholeDays -= 1;
  }
  return { day, hour: hour % HOURS_PER_DAY };
}

export function minimumScheduleWindow(today: Date, latest: Date | null) {
  const start = addDays(mondayOnOrBefore(today), -7);
  const minimumEnd = addDays(start, 27);
  return { start, end: latest && latest > minimumEnd ? sundayOnOrAfter(latest) : minimumEnd };
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shortDate(date: Date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function relativeWeekLabel(index: number) {
  return ["Last week", "This week", "Next week", "Week after next"][index] ?? `Week +${index - 1}`;
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

export function calculateTaskPlacements(issues: Issue[], skipWeekends = false) {
  const schedulable = issues.filter(hasSchedulableEffort);
  const firstDate = schedulable.map((issue) => issue.startDate!).sort()[0] ?? null;
  const placements = new Map<string, TaskPlacement>();
  if (!firstDate) return { firstDate, placements };
  const scheduleStart = skipWeekends ? nextWorkingDay(utcDay(firstDate)) : utcDay(firstDate);

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
    const issueStart = skipWeekends ? nextWorkingDay(utcDay(issue.startDate!)) : utcDay(issue.startDate!);
    const plannedStartHour = capacityHoursBetween(scheduleStart, issueStart, skipWeekends);
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
    const groupNames = names.length > 0 ? names : [BACKLOG_GROUP];
    for (const name of groupNames) groups.set(name, [...(groups.get(name) ?? []), issue]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left === BACKLOG_GROUP ? 1 : right === BACKLOG_GROUP ? -1 : left.localeCompare(right))
    .map(([name, groupedIssues]) => ({ name, issues: groupedIssues }));
}

export function visibleTaskScheduleGroups(groups: ScheduleGroup[], showBacklog: boolean) {
  return showBacklog ? groups : groups.filter((group) => group.name !== BACKLOG_GROUP);
}

function GroupChart({ group, projects, sortBy, skipWeekends }: { group: ScheduleGroup; projects: Map<string, Project>; sortBy: TaskSort; skipWeekends: boolean }) {
  const schedule = useMemo(() => calculateTaskPlacements(group.issues, skipWeekends), [group.issues, skipWeekends]);
  const sortedIssues = useMemo(() => sortScheduledTasks(group.issues, sortBy, schedule.placements), [group.issues, schedule.placements, sortBy]);
  const rawStart = schedule.firstDate ?? dateKey(new Date());
  const lastEndHour = Math.max(0, ...[...schedule.placements.values()].map((placement) => placement.endHour));
  const scheduleBase = skipWeekends ? nextWorkingDay(utcDay(rawStart)) : utcDay(rawStart);
  const latestPoint = calendarPointForCapacityHour(scheduleBase, Math.max(0, lastEndHour - 0.001), skipWeekends);
  const { start, end } = minimumScheduleWindow(todayUtc(), latestPoint.day);
  const dayCount = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => addDays(start, index));
  const weeks = Array.from({ length: Math.ceil(dayCount / 7) }, (_, index) => {
    const weekStart = addDays(start, index * 7);
    const weekEnd = addDays(weekStart, 6);
    const total = group.issues.reduce((sum, issue) => {
      const placement = schedule.placements.get(issue.id);
      if (!placement) return sum;
      const taskStart = calendarPointForCapacityHour(scheduleBase, placement.startHour, skipWeekends).day.getTime();
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
                  <span className="text-muted-foreground">{relativeWeekLabel(weeks.indexOf(week))} · {shortDate(week.start)} - {shortDate(week.end)}</span>
                  <span className="font-semibold tabular-nums">{hours(week.total)} H</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex h-7 border-b border-border text-[10px] text-muted-foreground">
            <div className="sticky left-0 z-20 w-[360px] shrink-0 border-r border-border bg-card" />
            {days.map((day) => (
              <div key={dateKey(day)} className={`relative flex shrink-0 items-center justify-center border-r border-border/60 ${day.getUTCDay() === 6 ? "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300" : day.getUTCDay() === 0 ? "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300" : ""}`} style={{ width: DAY_WIDTH }}>
                <span className="absolute inset-y-0 left-1/2 border-l border-dashed border-border/70" aria-hidden="true" />
                {day.getUTCDate()}
              </div>
            ))}
          </div>
          {sortedIssues.map((issue) => {
            const placement = schedule.placements.get(issue.id);
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
                    <span key={dateKey(day)} className="absolute inset-y-0 border-r border-border/50" style={{ left: (dayIndex + 1) * DAY_WIDTH - 1 }}>
                      <span className="absolute inset-y-0 border-l border-dashed border-border/40" style={{ left: -DAY_WIDTH / 2 }} aria-hidden="true" />
                    </span>
                  ))}
                  {placement && workWidth > 0 ? (() => {
                    const segments: Array<{ left: number; width: number; hours: number }> = [];
                    let cursor = placement.startHour;
                    let remaining = estimatedHours;
                    while (remaining > 0) {
                      const point = calendarPointForCapacityHour(scheduleBase, cursor, skipWeekends);
                      const segmentHours = skipWeekends ? Math.min(remaining, HOURS_PER_DAY - point.hour) : remaining;
                      const dayOffset = Math.round((point.day.getTime() - start.getTime()) / DAY_MS);
                      segments.push({
                        left: (dayOffset + point.hour / HOURS_PER_DAY) * DAY_WIDTH + 3,
                        width: Math.max(12, segmentHours / HOURS_PER_DAY * DAY_WIDTH - (skipWeekends ? 6 : 0)),
                        hours: segmentHours,
                      });
                      cursor += segmentHours;
                      remaining -= segmentHours;
                    }
                    return segments.map((segment, index) => (
                      <Link
                        key={`${issue.id}-${index}`}
                        to={issueUrl(issue)}
                        className={`absolute top-5 flex h-7 items-center rounded px-2 text-xs font-medium text-white shadow-sm no-underline ${statusColor(issue.status)}`}
                        style={{ left: segment.left, width: segment.width }}
                        title={`${issue.title} · planned ${issue.startDate ?? "—"} · ${hours(issue.estimatedHours)} H · priority ${issue.priority}${issue.dueDate ? ` · due reference ${issue.dueDate}` : ""}`}
                      >
                        <span className={segment.width < 36 ? "sr-only" : "truncate"}>{hours(segment.hours)} H</span>
                      </Link>
                    ));
                  })() : null}
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
  const [showBacklog, setShowBacklog] = useState(false);
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [hiddenAssignees, setHiddenAssignees] = useState<Set<string>>(() => new Set());
  const issuesQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "issues"],
    queryFn: () => issuesApi.list(companyId, { limit: 500, includeBlockedBy: true }),
  });
  const projectsQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "projects"],
    queryFn: () => projectsApi.list(companyId),
  });
  const agentsQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "agents"],
    queryFn: () => agentsApi.list(companyId),
  });
  const usersQuery = useQuery({
    queryKey: ["task-schedule-gantt", companyId, "users"],
    queryFn: () => accessApi.listUserDirectory(companyId),
  });
  const userLabels = useMemo(() => buildCompanyUserLabelMap(usersQuery.data?.users), [usersQuery.data?.users]);
  const assigneeOptions = useMemo(() => {
    const options = new Map<string, string>();
    const agentNames = new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name]));
    for (const issue of issuesQuery.data ?? []) {
      const key = assigneeKey(issue);
      if (key === "unassigned") options.set(key, "Unassigned");
      else if (issue.assigneeUserId) options.set(key, userLabels.get(issue.assigneeUserId) ?? issue.assigneeUserId.slice(0, 8));
      else if (issue.assigneeAgentId) options.set(key, agentNames.get(issue.assigneeAgentId) ?? issue.assigneeAgentId.slice(0, 8));
    }
    return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [agentsQuery.data, issuesQuery.data, userLabels]);
  const filteredIssues = useMemo(
    () => (issuesQuery.data ?? []).filter((issue) => !hiddenAssignees.has(assigneeKey(issue))),
    [hiddenAssignees, issuesQuery.data],
  );
  const groups = useMemo(() => buildTaskScheduleGroups(filteredIssues), [filteredIssues]);
  const backlogGroup = groups.find((group) => group.name === BACKLOG_GROUP);
  const visibleGroups = visibleTaskScheduleGroups(groups, showBacklog);
  const projectMap = useMemo(() => new Map((projectsQuery.data ?? []).map((project) => [project.id, project])), [projectsQuery.data]);
  const needsSchedule = filteredIssues.filter((issue) => !hasSchedulableEffort(issue)).length;

  if (issuesQuery.isLoading || projectsQuery.isLoading || agentsQuery.isLoading || usersQuery.isLoading) return <PageSkeleton />;
  if (issuesQuery.error || projectsQuery.error || agentsQuery.error || usersQuery.error) return <EmptyState icon={CalendarRange} message="Couldn't load the task schedule." />;
  if ((issuesQuery.data ?? []).length === 0) return <EmptyState icon={CalendarRange} message="No tasks to schedule." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div>
          <p>Grouped by schedule labels such as 202609-1s · bars use Start Date + Hours · Due Date is reference only</p>
          <p className={needsSchedule > 0 ? "font-medium text-amber-700 dark:text-amber-300" : undefined}>{needsSchedule} task{needsSchedule === 1 ? "" : "s"} need Start Date and Hours</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground">
            <input type="checkbox" checked={skipWeekends} onChange={(event) => setSkipWeekends(event.target.checked)} />
            Skip weekends
          </label>
          {backlogGroup ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setShowBacklog((value) => !value)}>
              {showBacklog ? "Hide" : "Show"} Backlog ({backlogGroup.issues.length})
            </Button>
          ) : null}
          <div className="flex items-center gap-1" aria-label="Task schedule sort">
            <span className="mr-1">Sort</span>
            <Button type="button" size="sm" variant={sortBy === "schedule" ? "secondary" : "ghost"} onClick={() => setSortBy("schedule")}>Schedule</Button>
            <Button type="button" size="sm" variant={sortBy === "start" ? "secondary" : "ghost"} onClick={() => setSortBy("start")}>Start Date</Button>
            <Button type="button" size="sm" variant={sortBy === "name" ? "secondary" : "ghost"} onClick={() => setSortBy("name")}>Task Name</Button>
          </div>
        </div>
      </div>
      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2">
        <legend className="px-1 text-xs font-medium text-foreground">Assignees</legend>
        {assigneeOptions.map(([key, label]) => (
          <label key={key} className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
            <input
              type="checkbox"
              checked={!hiddenAssignees.has(key)}
              onChange={(event) => setHiddenAssignees((current) => {
                const next = new Set(current);
                if (event.target.checked) next.delete(key);
                else next.add(key);
                return next;
              })}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {visibleGroups.length > 0 ? (
        visibleGroups.map((group) => <GroupChart key={group.name} group={group} projects={projectMap} sortBy={sortBy} skipWeekends={skipWeekends} />)
      ) : (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No tagged schedule groups. Show Backlog to review untagged tasks.
        </Card>
      )}
    </div>
  );
}

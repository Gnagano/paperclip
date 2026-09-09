import type { Issue, Project } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  buildTaskScheduleGroups,
  buildProjectScheduleGroups,
  calculateTaskPlacements,
  calendarPointForCapacityHour,
  minimumScheduleWindow,
  sortScheduledTasks,
  todayAtUtcOffset,
  visibleTaskScheduleGroups,
} from "./TaskScheduleGantt";

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    title: "Scheduled task",
    status: "todo",
    priority: "medium",
    startDate: "2026-09-03",
    dueDate: "2026-09-09",
    estimatedHours: 20,
    labels: [],
    ...overrides,
  } as Issue;
}

function label(id: string, name: string, color: string) {
  return { id, companyId: "company-1", name, color, createdAt: new Date(), updatedAt: new Date() };
}

describe("buildTaskScheduleGroups", () => {
  it("groups tasks by schedule label and puts tasks without one in Backlog", () => {
    const groups = buildTaskScheduleGroups([
      issue({ id: "one", labels: [label("label-1", "202609-1w", "#2563eb")] }),
      issue({ id: "two", labels: [label("label-2", "backend", "#64748b")] }),
      issue({ id: "three", startDate: null, dueDate: null }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(["202609-1w", "Backlog"]);
    expect(groups[0]?.issues.map((entry) => entry.id)).toEqual(["one"]);
    expect(groups[1]?.issues.map((entry) => entry.id)).toEqual(["two", "three"]);
    expect(visibleTaskScheduleGroups(groups, false).map((group) => group.name)).toEqual(["202609-1w"]);
    expect(visibleTaskScheduleGroups(groups, true).map((group) => group.name)).toEqual(["202609-1w", "Backlog"]);
  });

  it("includes a task in each matching schedule label", () => {
    const groups = buildTaskScheduleGroups([
      issue({ labels: [
        label("label-1", "202609-1w", "#2563eb"),
        label("label-2", "202609-w2", "#16a34a"),
      ] }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.issues[0]?.id === "issue-1")).toBe(true);
  });

  it("recognizes sprint labels in both supported positions", () => {
    const groups = buildTaskScheduleGroups([
      issue({ id: "sprint-one", labels: [label("label-s1", "202609-1s", "#2563eb")] }),
      issue({ id: "sprint-two", labels: [label("label-s2", "202609-s2", "#16a34a")] }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(["202609-1s", "202609-s2"]);
  });

  it("sorts tasks by start date or name", () => {
    const bravo = issue({ id: "bravo", title: "Bravo", startDate: "2026-09-08" });
    const alpha = issue({ id: "alpha", title: "Alpha", startDate: "2026-09-09" });

    expect(sortScheduledTasks([alpha, bravo], "start").map((entry) => entry.id)).toEqual(["bravo", "alpha"]);
    expect(sortScheduledTasks([bravo, alpha], "name").map((entry) => entry.id)).toEqual(["alpha", "bravo"]);
  });

  it("places higher-priority tasks first and queues their hours", () => {
    const lower = issue({ id: "lower", startDate: "2026-01-01", estimatedHours: 3, priority: "high" });
    const higher = issue({ id: "higher", startDate: "2026-01-01", estimatedHours: 5, priority: "critical" });
    const { placements } = calculateTaskPlacements([lower, higher]);

    expect(placements.get("higher")).toEqual({ startHour: 0, endHour: 5 });
    expect(placements.get("lower")).toEqual({ startHour: 5, endHour: 8 });
  });

  it("places a blocked task after its blocker", () => {
    const blocker = issue({ id: "blocker", startDate: "2026-01-01", estimatedHours: 6, priority: "low" });
    const blocked = issue({
      id: "blocked",
      startDate: "2026-01-01",
      estimatedHours: 2,
      priority: "critical",
      blockedBy: [{
        id: "blocker",
        identifier: "ECB-1",
        title: "Blocker",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: null,
        assigneeUserId: null,
      }],
    });
    const { placements } = calculateTaskPlacements([blocked, blocker]);

    expect(placements.get("blocker")).toEqual({ startHour: 0, endHour: 6 });
    expect(placements.get("blocked")).toEqual({ startHour: 6, endHour: 8 });
  });

  it("always shows last week through the week after next", () => {
    const { start, end } = minimumScheduleWindow(
      new Date("2026-09-09T00:00:00Z"),
      new Date("2026-09-10T00:00:00Z"),
    );
    expect(start.toISOString().slice(0, 10)).toBe("2026-08-31");
    expect(end.toISOString().slice(0, 10)).toBe("2026-09-27");
  });

  it("moves the second workday from Saturday to Monday when weekends are skipped", () => {
    const friday = new Date("2026-09-11T00:00:00Z");
    expect(calendarPointForCapacityHour(friday, 8, false).day.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(calendarPointForCapacityHour(friday, 8, true).day.toISOString().slice(0, 10)).toBe("2026-09-14");
  });

  it("derives today from GMT+8 across the UTC date boundary", () => {
    expect(todayAtUtcOffset(new Date("2026-09-09T15:59:59Z")).toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(todayAtUtcOffset(new Date("2026-09-09T16:00:00Z")).toISOString().slice(0, 10)).toBe("2026-09-10");
  });
});

describe("buildProjectScheduleGroups", () => {
  it("groups tasks by project and keeps unassigned tasks in No Project", () => {
    const projects = new Map([
      ["project-1", { id: "project-1", name: "Bravo" } as Project],
      ["project-2", { id: "project-2", name: "Alpha" } as Project],
    ]);
    const groups = buildProjectScheduleGroups([
      issue({ id: "bravo", projectId: "project-1" }),
      issue({ id: "alpha", projectId: "project-2" }),
      issue({ id: "none", projectId: null }),
    ], projects);

    expect(groups.map((group) => group.name)).toEqual(["Alpha", "Bravo", "No Project"]);
    expect(groups.find((group) => group.name === "No Project")?.issues[0]?.id).toBe("none");
  });
});

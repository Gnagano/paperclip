import type { Issue } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { buildTaskScheduleGroups, sortScheduledTasks } from "./TaskScheduleGantt";

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    title: "Scheduled task",
    status: "todo",
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
  it("groups dated tasks by schedule label and puts other dated tasks in a fallback group", () => {
    const groups = buildTaskScheduleGroups([
      issue({ id: "one", labels: [label("label-1", "202609-1w", "#2563eb")] }),
      issue({ id: "two", labels: [label("label-2", "backend", "#64748b")] }),
      issue({ id: "three", startDate: null, dueDate: null }),
    ]);

    expect(groups.map((group) => group.name)).toEqual(["202609-1w", "Other scheduled tasks"]);
    expect(groups[0]?.issues.map((entry) => entry.id)).toEqual(["one"]);
    expect(groups[1]?.issues.map((entry) => entry.id)).toEqual(["two"]);
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

  it("sorts tasks by start date or name", () => {
    const bravo = issue({ id: "bravo", title: "Bravo", startDate: "2026-09-08" });
    const alpha = issue({ id: "alpha", title: "Alpha", startDate: "2026-09-09" });

    expect(sortScheduledTasks([alpha, bravo], "start").map((entry) => entry.id)).toEqual(["bravo", "alpha"]);
    expect(sortScheduledTasks([bravo, alpha], "name").map((entry) => entry.id)).toEqual(["alpha", "bravo"]);
  });
});

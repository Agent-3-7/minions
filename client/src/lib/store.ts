import { create } from 'zustand';
import type { Task, TaskRunState, TaskStatus } from '@shared/types';

interface AppState {
  tasks: Task[];
  taskRuns: Map<string, TaskRunState>;
  tasksLoaded: boolean;
  sidebarCollapsed: boolean;
  subissuesByParent: Map<string, Task[]>;

  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setTaskRuns: (runs: TaskRunState[]) => void;
  setTaskRun: (run: TaskRunState) => void;
  toggleSidebar: () => void;
  setSubissues: (parentId: string, subissues: Task[]) => void;
  upsertSubissue: (parentId: string, subissue: Task) => void;
}

function tasksEqual(a: Task, b: Task): boolean {
  return a.updated_at === b.updated_at && a.last_viewed_at === b.last_viewed_at;
}

export function isActiveRun(run: TaskRunState): boolean {
  return run.status === 'streaming' || run.status === 'compacting';
}

function taskRunEqual(a: TaskRunState | undefined, b: TaskRunState): boolean {
  if (!a) return false;
  return (
    a.runId === b.runId &&
    a.status === b.status &&
    a.kind === b.kind &&
    a.goal?.turnsUsed === b.goal?.turnsUsed &&
    a.goal?.maxTurns === b.goal?.maxTurns &&
    a.goal?.status === b.goal?.status
  );
}

function sortedSubissues(tasks: Task[], parentId: string): Task[] {
  return tasks
    .filter((candidate) => candidate.parent_task_id === parentId)
    .sort((a, b) => a.created_at - b.created_at);
}

function buildSubissuesByParent(tasks: Task[]): Map<string, Task[]> {
  const grouped = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const existing = grouped.get(task.parent_task_id) ?? [];
    existing.push(task);
    grouped.set(task.parent_task_id, existing);
  }
  for (const subissues of grouped.values()) {
    subissues.sort((a, b) => a.created_at - b.created_at);
  }
  return grouped;
}

export const useStore = create<AppState>((set) => ({
  tasks: [],
  taskRuns: new Map<string, TaskRunState>(),
  tasksLoaded: false,
  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
  subissuesByParent: new Map<string, Task[]>(),

  setTasks: (tasks) => set({ tasks, tasksLoaded: true, subissuesByParent: buildSubissuesByParent(tasks) }),

  upsertTask: (task) =>
    set((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      const existing = idx === -1 ? null : state.tasks[idx];
      if (idx === -1) {
        const tasks = [...state.tasks, task];
        if (!task.parent_task_id) return { tasks };
        const subissuesByParent = new Map(state.subissuesByParent);
        subissuesByParent.set(task.parent_task_id, sortedSubissues(tasks, task.parent_task_id));
        return { tasks, subissuesByParent };
      }
      if (tasksEqual(existing, task)) return state;
      const next = [...state.tasks];
      next[idx] = task;
      if (!task.parent_task_id && !existing.parent_task_id) return { tasks: next };

      const subissuesByParent = new Map(state.subissuesByParent);
      const affectedParentIds = new Set<string>();
      if (existing.parent_task_id) affectedParentIds.add(existing.parent_task_id);
      if (task.parent_task_id) affectedParentIds.add(task.parent_task_id);
      for (const parentId of affectedParentIds) {
        subissuesByParent.set(parentId, sortedSubissues(next, parentId));
      }
      return { tasks: next, subissuesByParent };
    }),

  removeTask: (taskId) =>
    set((state) => {
      const removed = state.tasks.find((t) => t.id === taskId);
      const tasks = state.tasks.filter((t) => t.id !== taskId);
      const subissuesByParent = removed?.parent_task_id ? new Map(state.subissuesByParent) : state.subissuesByParent;
      if (removed?.parent_task_id) {
        subissuesByParent.set(removed.parent_task_id, sortedSubissues(tasks, removed.parent_task_id));
      }
      if (!state.taskRuns.has(taskId)) return { tasks, subissuesByParent };
      const taskRuns = new Map(state.taskRuns);
      taskRuns.delete(taskId);
      return { tasks, taskRuns, subissuesByParent };
    }),

  setTaskRuns: (runs) =>
    set((state) => {
      const activeRuns = runs.filter(isActiveRun);
      if (
        activeRuns.length === state.taskRuns.size &&
        activeRuns.every((run) => taskRunEqual(state.taskRuns.get(run.taskId), run))
      ) {
        return state;
      }
      return { taskRuns: new Map(activeRuns.map((run) => [run.taskId, run])) };
    }),

  setTaskRun: (run) =>
    set((state) => {
      const current = state.taskRuns.get(run.taskId);
      const shouldStore = isActiveRun(run);
      if (
        (!shouldStore && !current) ||
        (shouldStore && taskRunEqual(current, run))
      ) {
        return state;
      }

      const taskRuns = new Map(state.taskRuns);
      if (shouldStore) taskRuns.set(run.taskId, run);
      else taskRuns.delete(run.taskId);
      return { taskRuns };
    }),

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      localStorage.setItem('sidebarCollapsed', String(next));
      return { sidebarCollapsed: next };
    }),

  setSubissues: (parentId, subissues) =>
    set((state) => {
      const subissuesByParent = new Map(state.subissuesByParent);
      subissuesByParent.set(parentId, subissues);
      return { subissuesByParent };
    }),

  upsertSubissue: (parentId, subissue) =>
    set((state) => {
      const subissuesByParent = new Map(state.subissuesByParent);
      const existing = subissuesByParent.get(parentId) ?? [];
      const idx = existing.findIndex((t) => t.id === subissue.id);
      let next: Task[];
      if (idx === -1) {
        next = [...existing, subissue];
      } else {
        next = [...existing];
        next[idx] = subissue;
      }
      subissuesByParent.set(parentId, next);
      return { subissuesByParent };
    }),
}));

export async function optimisticMoveTask(
  task: Task,
  status: TaskStatus,
  upsertTask: (t: Task) => void,
  apiMove: (id: string, s: TaskStatus) => Promise<{ task: Task }>,
) {
  upsertTask({ ...task, status, updated_at: Date.now() });
  try {
    const res = await apiMove(task.id, status);
    upsertTask(res.task);
  } catch {
    upsertTask(task);
  }
}

import { create } from 'zustand';
import type { Task, TaskRunState, TaskStatus } from '@shared/types';

interface AppState {
  tasks: Task[];
  taskRuns: Map<string, TaskRunState>;
  tasksLoaded: boolean;
  sidebarCollapsed: boolean;
  subtasksByParent: Map<string, Task[]>;

  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setTaskRuns: (runs: TaskRunState[]) => void;
  setTaskRun: (run: TaskRunState) => void;
  toggleSidebar: () => void;
  setSubtasks: (parentId: string, subtasks: Task[]) => void;
  upsertSubtask: (parentId: string, subtask: Task) => void;
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

function sortedSubtasks(tasks: Task[], parentId: string): Task[] {
  return tasks
    .filter((candidate) => candidate.parent_task_id === parentId)
    .sort((a, b) => a.created_at - b.created_at);
}

function buildSubtasksByParent(tasks: Task[]): Map<string, Task[]> {
  const grouped = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.parent_task_id) continue;
    const existing = grouped.get(task.parent_task_id) ?? [];
    existing.push(task);
    grouped.set(task.parent_task_id, existing);
  }
  for (const subtasks of grouped.values()) {
    subtasks.sort((a, b) => a.created_at - b.created_at);
  }
  return grouped;
}

export const useStore = create<AppState>((set) => ({
  tasks: [],
  taskRuns: new Map<string, TaskRunState>(),
  tasksLoaded: false,
  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
  subtasksByParent: new Map<string, Task[]>(),

  setTasks: (tasks) => set({ tasks, tasksLoaded: true, subtasksByParent: buildSubtasksByParent(tasks) }),

  upsertTask: (task) =>
    set((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      const existing = idx === -1 ? null : state.tasks[idx];
      if (idx === -1) {
        const tasks = [...state.tasks, task];
        if (!task.parent_task_id) return { tasks };
        const subtasksByParent = new Map(state.subtasksByParent);
        subtasksByParent.set(task.parent_task_id, sortedSubtasks(tasks, task.parent_task_id));
        return { tasks, subtasksByParent };
      }
      if (tasksEqual(existing, task)) return state;
      const next = [...state.tasks];
      next[idx] = task;
      if (!task.parent_task_id && !existing.parent_task_id) return { tasks: next };

      const subtasksByParent = new Map(state.subtasksByParent);
      const affectedParentIds = new Set<string>();
      if (existing.parent_task_id) affectedParentIds.add(existing.parent_task_id);
      if (task.parent_task_id) affectedParentIds.add(task.parent_task_id);
      for (const parentId of affectedParentIds) {
        subtasksByParent.set(parentId, sortedSubtasks(next, parentId));
      }
      return { tasks: next, subtasksByParent };
    }),

  removeTask: (taskId) =>
    set((state) => {
      const removed = state.tasks.find((t) => t.id === taskId);
      const tasks = state.tasks.filter((t) => t.id !== taskId);
      const subtasksByParent = removed?.parent_task_id ? new Map(state.subtasksByParent) : state.subtasksByParent;
      if (removed?.parent_task_id) {
        subtasksByParent.set(removed.parent_task_id, sortedSubtasks(tasks, removed.parent_task_id));
      }
      if (!state.taskRuns.has(taskId)) return { tasks, subtasksByParent };
      const taskRuns = new Map(state.taskRuns);
      taskRuns.delete(taskId);
      return { tasks, taskRuns, subtasksByParent };
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

  setSubtasks: (parentId, subtasks) =>
    set((state) => {
      const subtasksByParent = new Map(state.subtasksByParent);
      subtasksByParent.set(parentId, subtasks);
      return { subtasksByParent };
    }),

  upsertSubtask: (parentId, subtask) =>
    set((state) => {
      const subtasksByParent = new Map(state.subtasksByParent);
      const existing = subtasksByParent.get(parentId) ?? [];
      const idx = existing.findIndex((t: Task) => t.id === subtask.id);
      let next: Task[];
      if (idx === -1) {
        next = [...existing, subtask];
      } else {
        next = [...existing];
        next[idx] = subtask;
      }
      subtasksByParent.set(parentId, next);
      return { subtasksByParent };
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

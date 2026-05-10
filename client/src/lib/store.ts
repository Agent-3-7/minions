import { create } from 'zustand';
import type { Task, TaskStatus } from '@shared/types';

interface AppState {
  tasks: Task[];
  tasksLoaded: boolean;
  sidebarCollapsed: boolean;

  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  toggleSidebar: () => void;
}

function tasksEqual(a: Task, b: Task): boolean {
  return a.updated_at === b.updated_at && a.last_viewed_at === b.last_viewed_at;
}

export const useStore = create<AppState>((set) => ({
  tasks: [],
  tasksLoaded: false,
  sidebarCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',

  setTasks: (tasks) => set({ tasks, tasksLoaded: true }),

  upsertTask: (task) =>
    set((state) => {
      const idx = state.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [...state.tasks, task] };
      const existing = state.tasks[idx];
      if (tasksEqual(existing, task)) return state;
      const next = [...state.tasks];
      next[idx] = task;
      return { tasks: next };
    }),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      localStorage.setItem('sidebarCollapsed', String(next));
      return { sidebarCollapsed: next };
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

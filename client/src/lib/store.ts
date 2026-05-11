import { create } from 'zustand';
import type { Task, TaskStatus } from '@shared/types';

interface AppState {
  tasks: Task[];
  streamingTaskIds: Set<string>;
  tasksLoaded: boolean;
  sidebarCollapsed: boolean;

  setTasks: (tasks: Task[]) => void;
  upsertTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  setStreamingTasks: (ids: string[]) => void;
  setTaskStreaming: (taskId: string, streaming: boolean) => void;
  toggleSidebar: () => void;
}

function tasksEqual(a: Task, b: Task): boolean {
  return a.updated_at === b.updated_at && a.last_viewed_at === b.last_viewed_at;
}

export const useStore = create<AppState>((set) => ({
  tasks: [],
  streamingTaskIds: new Set<string>(),
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
    set((state) => {
      const tasks = state.tasks.filter((t) => t.id !== taskId);
      if (!state.streamingTaskIds.has(taskId)) return { tasks };
      const next = new Set(state.streamingTaskIds);
      next.delete(taskId);
      return { tasks, streamingTaskIds: next };
    }),

  setStreamingTasks: (ids) =>
    set((state) => {
      if (ids.length === state.streamingTaskIds.size && ids.every((id) => state.streamingTaskIds.has(id))) {
        return state;
      }
      return { streamingTaskIds: new Set(ids) };
    }),

  setTaskStreaming: (taskId, streaming) =>
    set((state) => {
      if (streaming === state.streamingTaskIds.has(taskId)) return state;
      const next = new Set(state.streamingTaskIds);
      if (streaming) next.add(taskId);
      else next.delete(taskId);
      return { streamingTaskIds: next };
    }),

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

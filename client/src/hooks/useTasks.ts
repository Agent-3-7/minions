import { useEffect, useRef } from 'react';
import type { BoardEvent } from '@shared/types';
import { useStore } from '../lib/store';
import { fetchTasks } from '../lib/api';
import { playCompletionSound } from './useSoundOnComplete';
import { useVisibilityRefresh } from './useVisibilityRefresh';

export function useTasks() {
  const setTasks = useStore((s) => s.setTasks);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const setTaskRuns = useStore((s) => s.setTaskRuns);
  const setTaskRun = useStore((s) => s.setTaskRun);
  const retryRef = useRef(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    fetchTasks().then((res) => {
      const countByParent = new Map<string, number>();
      for (const t of res.tasks) {
        if (t.parent_task_id) {
          countByParent.set(t.parent_task_id, (countByParent.get(t.parent_task_id) ?? 0) + 1);
        }
      }
      const tasks = res.tasks.map((t) => ({
        ...t,
        child_count: countByParent.get(t.id) ?? 0,
      }));
      setTasks(tasks);
    }).catch(console.error);
  }, [setTasks]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function startPolling() {
      if (pollingRef.current) return;
      pollingRef.current = setInterval(() => {
        fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
      }, 30_000);
    }

    function stopPolling() {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }

    function connect() {
      if (cancelled) return;
      es?.close();
      es = new EventSource('/api/events');
      esRef.current = es;

      es.onopen = () => {
        if (retryRef.current > 0) {
          fetchTasks().then((res) => {
            const countByParent = new Map<string, number>();
            for (const t of res.tasks) {
              if (t.parent_task_id) {
                countByParent.set(t.parent_task_id, (countByParent.get(t.parent_task_id) ?? 0) + 1);
              }
            }
            setTasks(res.tasks.map((t) => ({ ...t, child_count: countByParent.get(t.id) ?? 0 })));
          }).catch(console.error);
        }
        retryRef.current = 0;
        stopPolling();
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as BoardEvent;
          if (event.type === 'task_created' || event.type === 'task_updated') {
            if (event.type === 'task_updated') {
              const prev = useStore.getState().tasks.find((t) => t.id === event.task.id);
              if (prev && prev.status === 'in_progress' && event.task.status === 'in_review') {
                playCompletionSound();
              }
            }
            upsertTask(event.task);
          } else if (event.type === 'task_deleted') {
            removeTask(event.taskId);
          } else if (event.type === 'task_runs_snapshot') {
            setTaskRuns(event.runs);
          } else if (event.type === 'task_run_updated') {
            setTaskRun(event.run);
          }
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        startPolling();
        const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
        retryRef.current++;
        retryTimeout = setTimeout(connect, delay);
      };
    }

    reconnectRef.current = () => {
      if (cancelled) return;
      clearTimeout(retryTimeout);
      retryRef.current = 0;
      try {
        es?.close();
      } catch {}
      connect();
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      es?.close();
      stopPolling();
      esRef.current = null;
      reconnectRef.current = null;
    };
  }, [setTasks, upsertTask, removeTask, setTaskRuns, setTaskRun]);

  // Refetch immediately when returning to foreground (iOS background → foreground)
  useVisibilityRefresh(() => {
    fetchTasks()
      .then((res) => setTasks(res.tasks))
      .catch(console.error);

    // If SSE is closed, reconnect immediately
    if (esRef.current && esRef.current.readyState === EventSource.CLOSED) {
      reconnectRef.current?.();
    }
  });
}

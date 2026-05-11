import { useEffect, useRef } from 'react';
import type { BoardEvent } from '@shared/types';
import { useStore } from '../lib/store';
import { fetchTasks } from '../lib/api';

export function useTasks() {
  const setTasks = useStore((s) => s.setTasks);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const setStreamingTasks = useStore((s) => s.setStreamingTasks);
  const setTaskStreaming = useStore((s) => s.setTaskStreaming);
  const retryRef = useRef(0);

  useEffect(() => {
    fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
  }, [setTasks]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      es = new EventSource('/api/events');

      es.onopen = () => {
        if (retryRef.current > 0) {
          fetchTasks().then((res) => setTasks(res.tasks)).catch(console.error);
        }
        retryRef.current = 0;
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as BoardEvent;
          if (event.type === 'task_created' || event.type === 'task_updated') {
            upsertTask(event.task);
          } else if (event.type === 'task_deleted') {
            removeTask(event.taskId);
          } else if (event.type === 'task_runs_snapshot') {
            setStreamingTasks(event.runs.filter((r) => r.status === 'streaming').map((r) => r.taskId));
          } else if (event.type === 'task_run_updated') {
            setTaskStreaming(event.run.taskId, event.run.status === 'streaming');
          }
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        const delay = Math.min(1000 * 2 ** retryRef.current, 30_000);
        retryRef.current++;
        retryTimeout = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, [setTasks, upsertTask, removeTask, setStreamingTasks, setTaskStreaming]);
}

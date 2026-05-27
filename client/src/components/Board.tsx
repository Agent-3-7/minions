import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { AlertTriangle, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScheduledTask, Task, TaskStatus } from '@shared/types';
import { TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { useStore, optimisticMoveTask } from '../lib/store';
import { deleteTask, fetchScheduledTasks, moveTask, ApiError } from '../lib/api';
import { buildScheduledTaskFixDraft } from '../lib/scheduledTaskFix';
import { relativeTime } from '../lib/schedule';
import { Column } from './Column';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { AgentControlCardOverlay } from './AgentControlCard';
import { toast } from 'sonner';

const dropAnimation = {
  duration: 200,
  easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
};

function scheduledTaskRunsPath(scheduledTaskId: string): string {
  return `/scheduled-tasks/${scheduledTaskId}/runs`;
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function scheduledTaskNeedsAttention(scheduledTask: ScheduledTask): boolean {
  if (!scheduledTask.enabled) return false;
  return (
    scheduledTask.lastStatus === 'error'
    || Boolean(scheduledTask.lastError || scheduledTask.lastDeliveryError)
  );
}

function scheduledTaskAttentionReason(scheduledTask: ScheduledTask): string {
  if (scheduledTask.lastStatus === 'error' || scheduledTask.lastError) return 'failed';
  if (scheduledTask.lastDeliveryError) return 'had a delivery issue';
  return 'needs attention';
}

function RecurringSummaryStrip({ scheduledTasks }: { scheduledTasks: ScheduledTask[] }) {
  const attentionTasks = scheduledTasks
    .filter(scheduledTaskNeedsAttention)
    .sort((a, b) => (timestamp(b.lastRunAt) ?? 0) - (timestamp(a.lastRunAt) ?? 0));

  if (attentionTasks.length === 0) return null;

  const attentionTask = attentionTasks[0];
  const attentionReason = scheduledTaskAttentionReason(attentionTask);
  const summary = `${attentionTasks.length} need${attentionTasks.length === 1 ? 's' : ''} attention: ${attentionTask.name} ${attentionReason}${attentionTask.lastRunAt ? ` ${relativeTime(attentionTask.lastRunAt)}` : ''}`;

  return (
    <div className="mx-3 mt-3 flex min-h-11 items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 sm:mx-6 sm:mt-4 sm:px-3.5 dark:border-rose-900/60 dark:bg-rose-950/20 dark:text-rose-300">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertTriangle size={14} strokeWidth={2.4} />
        </span>
        <span className="shrink-0 font-semibold text-zinc-900 dark:text-zinc-100">Recurring</span>
        <span className="min-w-0 truncate">{summary}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Link
          to="/tasks/new"
          state={{ draft: buildScheduledTaskFixDraft(attentionTask) }}
          className="inline-flex items-center gap-1 rounded-md bg-rose-700 px-2 py-1 font-semibold text-white transition-colors hover:bg-rose-800 dark:bg-rose-300 dark:text-rose-950 dark:hover:bg-rose-200"
        >
          <Wrench size={13} />
          Fix it
        </Link>
        <Link
          to={scheduledTaskRunsPath(attentionTask.id)}
          className="rounded-md px-2 py-1 font-semibold text-rose-800 transition-colors hover:bg-rose-100 dark:text-rose-200 dark:hover:bg-rose-950/40"
        >
          Review →
        </Link>
      </div>
    </div>
  );
}

export function Board() {
  const tasks = useStore((s) => s.tasks);
  const taskRuns = useStore((s) => s.taskRuns);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const grouped = useMemo(() => {
    const buckets: Record<TaskStatus, Task[]> = {
      todo: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    for (const t of tasks) {
      if (t.parent_task_id) continue;
      if (t.status in buckets) buckets[t.status].push(t);
    }
    for (const s of TASK_STATUSES) buckets[s].sort((a, b) => b.updated_at - a.updated_at);
    return buckets;
  }, [tasks]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [deleteAllStatus, setDeleteAllStatus] = useState<TaskStatus | null>(null);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadScheduledTasks() {
      try {
        const result = await fetchScheduledTasks(true);
        if (!cancelled) setScheduledTasks(result.scheduledTasks);
      } catch (error) {
        console.error(error);
      }
    }

    void loadScheduledTasks();
    return () => {
      cancelled = true;
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    const task = (event.active.data.current as { task: Task } | undefined)?.task ?? null;
    setActiveTask(task);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const targetStatus = over.id as TaskStatus;
    const task = (active.data.current as { task: Task })?.task;
    if (!task || task.status === targetStatus) return;

    try {
      await optimisticMoveTask(task, targetStatus, upsertTask, moveTask);
    } catch (error) {
      toast.error('Task not completed', {
        description: error instanceof ApiError ? error.message : 'Linked PR could not be merged.',
      });
    }
  }

  function handleRequestDeleteAll(status: TaskStatus) {
    setBulkDeleteError(null);
    setDeleteAllStatus(status);
  }

  function handleCancelDeleteAll() {
    if (isBulkDeleting) return;
    setDeleteAllStatus(null);
    setBulkDeleteError(null);
  }

  async function handleConfirmDeleteAll() {
    if (!deleteAllStatus || isBulkDeleting) return;

    const targets = grouped[deleteAllStatus];
    if (targets.length === 0) {
      handleCancelDeleteAll();
      return;
    }

    setIsBulkDeleting(true);
    setBulkDeleteError(null);
    try {
      const results = await Promise.allSettled(targets.map((task) => deleteTask(task.id)));
      let failed = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          removeTask(targets[index].id);
        } else {
          failed += 1;
        }
      });

      if (failed === 0) {
        setDeleteAllStatus(null);
      } else {
        setBulkDeleteError(`Failed to delete ${failed} task${failed === 1 ? '' : 's'}.`);
      }
    } finally {
      setIsBulkDeleting(false);
    }
  }

  const deleteAllTasks = deleteAllStatus ? grouped[deleteAllStatus] : [];
  const deleteAllLabel = deleteAllStatus ? STATUS_META[deleteAllStatus].label : '';
  const deleteAllCount = deleteAllTasks.length;
  const deleteAllTaskWord = deleteAllCount === 1 ? 'task' : 'tasks';

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-1 min-h-0 flex-col">
        <RecurringSummaryStrip scheduledTasks={scheduledTasks} />
        <div className="flex flex-1 snap-x snap-mandatory gap-4 overflow-x-auto overflow-y-hidden p-3 min-h-0 overscroll-x-contain pb-5 sm:gap-6 sm:p-6 sm:pb-6">
          {TASK_STATUSES.map((status, index) => (
            <Column
              key={status}
              status={status}
              tasks={grouped[status]}
              taskRuns={taskRuns}
              isLast={index === TASK_STATUSES.length - 1}
              onRequestDeleteAll={handleRequestDeleteAll}
            />
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask && (
          <AgentControlCardOverlay
            task={activeTask}
            run={taskRuns.get(activeTask.id)}
          />
        )}
      </DragOverlay>
      {deleteAllStatus && (
        <DeleteConfirmModal
          title={`Delete ${deleteAllCount} ${deleteAllLabel} ${deleteAllTaskWord}?`}
          body={
            deleteAllCount === 1
              ? `This removes the task in ${deleteAllLabel} from AgentControl. The Hermes session history remains in Hermes.`
              : `This removes every task in ${deleteAllLabel} from AgentControl. Hermes session histories remain in Hermes.`
          }
          confirmLabel={deleteAllCount === 1 ? 'Delete task' : `Delete ${deleteAllCount} tasks`}
          isConfirming={isBulkDeleting}
          error={bulkDeleteError}
          onConfirm={handleConfirmDeleteAll}
          onCancel={handleCancelDeleteAll}
        />
      )}
    </DndContext>
  );
}

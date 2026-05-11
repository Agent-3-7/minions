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
import { useMemo, useState } from 'react';
import type { Task, TaskStatus } from '@shared/types';
import { TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { useStore, optimisticMoveTask } from '../lib/store';
import { deleteTask, moveTask } from '../lib/api';
import { Column } from './Column';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { TaskCardOverlay } from './TaskCard';

const dropAnimation = {
  duration: 200,
  easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
};

export function Board() {
  const tasks = useStore((s) => s.tasks);
  const streamingTaskIds = useStore((s) => s.streamingTaskIds);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const grouped = useMemo(() => {
    const buckets: Record<TaskStatus, Task[]> = { in_progress: [], in_review: [], done: [] };
    for (const t of tasks) {
      if (t.status in buckets) buckets[t.status].push(t);
    }
    for (const s of TASK_STATUSES) buckets[s].sort((a, b) => b.updated_at - a.updated_at);
    return buckets;
  }, [tasks]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [deleteAllStatus, setDeleteAllStatus] = useState<TaskStatus | null>(null);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

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

    await optimisticMoveTask(task, targetStatus, upsertTask, moveTask);
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
      <div className="flex gap-6 p-6 overflow-x-auto flex-1 min-h-0">
        {TASK_STATUSES.map((status, index) => (
          <Column
            key={status}
            status={status}
            tasks={grouped[status]}
            streamingTaskIds={streamingTaskIds}
            isLast={index === TASK_STATUSES.length - 1}
            onRequestDeleteAll={handleRequestDeleteAll}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={dropAnimation}>
        {activeTask && (
          <TaskCardOverlay
            task={activeTask}
            isStreaming={streamingTaskIds.has(activeTask.id)}
          />
        )}
      </DragOverlay>
      {deleteAllStatus && (
        <DeleteConfirmModal
          title={`Delete ${deleteAllCount} ${deleteAllLabel} ${deleteAllTaskWord}?`}
          body={
            deleteAllCount === 1
              ? `This removes the task in ${deleteAllLabel} from Minions. The Hermes session history remains in Hermes.`
              : `This removes every task in ${deleteAllLabel} from Minions. Hermes session histories remain in Hermes.`
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

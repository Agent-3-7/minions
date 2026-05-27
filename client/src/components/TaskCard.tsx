import { useCallback, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Loader2, MoreHorizontal, Target, GitBranch, GitPullRequest, CheckCircle2, XCircle, AlertTriangle, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Task, TaskRunState } from '@shared/types';
import { goalTurnLabel, timeAgo } from '../lib/format';
import { isActiveRun } from '../lib/store';
import { hasUnseenAgentResponse } from '../lib/taskState';
import { TaskContextMenu } from './TaskContextMenu';
import { RenameTitle } from './RenameTitle';

const BUSY_LABELS: Record<string, string> = { compact: 'Compacting...', goal: 'Working toward goal...' };

function CompactKanbanBadge({ task }: { task: Task }) {
  if (!task.hermes_kanban_task_id || !task.delegation_profile) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:border-violet-900/70 dark:bg-violet-950/30 dark:text-violet-300">
      <GitBranch size={10} strokeWidth={2.5} className="shrink-0" />
      <span className="shrink-0">{task.delegation_profile}</span>
    </span>
  );
}

function CompactGitHubBadge({ task }: { task: Task }) {
  if (!task.github_pr_number || !task.github_pr_state) return null;

  const stateIcons: Record<string, React.ReactNode> = {
    OPEN: <GitPullRequest size={10} strokeWidth={2.5} className="shrink-0" />,
    MERGED: <CheckCircle2 size={10} strokeWidth={2.5} className="shrink-0" />,
    CLOSED: <XCircle size={10} strokeWidth={2.5} className="shrink-0" />,
  };

  const checkTints: Record<string, string> = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300',
    failure: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300',
    pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300',
    unknown: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
  };

  const checks = task.github_checks_status || 'unknown';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${checkTints[checks]}`}>
      {stateIcons[task.github_pr_state] || <GitPullRequest size={10} strokeWidth={2.5} className="shrink-0" />}
      <span className="shrink-0">PR #{task.github_pr_number}</span>
    </span>
  );
}

function TaskCardBody({ task, run }: { task: Task; run?: TaskRunState }) {
  const isUnseen = hasUnseenAgentResponse(task);
  const isBusy = !!run && isActiveRun(run);
  const isGoalRun = run?.kind === 'goal' && run.status === 'streaming';
  const compactGoalLabel = isGoalRun ? goalTurnLabel(run.goal?.turnsUsed ?? 0, run.goal?.maxTurns ?? 0, true) : null;
  const busyLabel = (run?.kind && BUSY_LABELS[run.kind]) || 'Working...';
  const showBusyState = isBusy && !isGoalRun;
  const timeRowClass = showBusyState
    ? 'font-semibold text-zinc-600 dark:text-zinc-300'
    : isUnseen
      ? 'font-semibold text-zinc-700 dark:text-zinc-200'
      : 'text-zinc-400 dark:text-zinc-500';

  return (
    <div>
      <RenameTitle
        value={task.title}
        identity={task.id}
        className={`block text-sm text-zinc-900 dark:text-zinc-100 line-clamp-2 ${
          isUnseen ? 'font-semibold' : 'font-medium'
        }`}
      />
      {task.description && (
        <p
          className={`mt-1 text-xs line-clamp-1 ${
            isUnseen
              ? 'text-zinc-600 dark:text-zinc-300'
              : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {task.description}
        </p>
      )}
      {(task.hermes_kanban_task_id || task.github_pr_number) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <CompactKanbanBadge task={task} />
          <CompactGitHubBadge task={task} />
        </div>
      )}
      <div className="mt-3 -mr-[18px] flex min-w-0 items-center gap-2">
        <div className={`flex min-w-0 flex-1 items-center gap-1.5 text-[11px] leading-none ${timeRowClass}`}>
          {showBusyState ? (
            <Loader2 size={12} className="shrink-0 animate-spin" strokeWidth={2.5} />
          ) : isUnseen && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-700 ring-4 ring-zinc-100 dark:bg-zinc-200 dark:ring-zinc-800" />
          )}
          <span className="truncate">{showBusyState ? busyLabel : timeAgo(task.updated_at)}</span>
        </div>
        {isGoalRun && (
          <span
            title={compactGoalLabel ? `Active goal run (${compactGoalLabel})` : 'Active goal run'}
            className="inline-flex h-5 max-w-[68%] shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 text-[11px] font-semibold leading-none text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-200"
          >
            <Target size={12} strokeWidth={2.5} className="shrink-0" />
            <span className="shrink-0">Goal active</span>
            {compactGoalLabel && (
              <span className="min-w-0 truncate font-medium text-zinc-500 dark:text-zinc-400">
                {compactGoalLabel}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export function TaskCard({ task, run }: { task: Task; run?: TaskRunState }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id: task.id, data: { task } });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const isUnseen = hasUnseenAgentResponse(task);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleMenuButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu((current) => (
      current ? null : { x: rect.left, y: rect.bottom + 6 }
    ));
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const stopPropagation = useCallback((e: { stopPropagation(): void }) => {
    e.stopPropagation();
  }, []);

  return (
    <>
      <div
        ref={setNodeRef}
        onContextMenu={handleContextMenu}
        className={`group/card relative rounded-lg bg-white dark:bg-zinc-900 border cursor-grab active:cursor-grabbing select-none transition-[opacity,box-shadow,border-color] duration-150 ${
          isDragging
            ? 'opacity-30 border-dashed border-zinc-300 dark:border-zinc-600 shadow-none'
            : isUnseen
              ? 'border-zinc-400 dark:border-zinc-600 shadow-lg hover:shadow-xl hover:border-zinc-400 dark:hover:border-zinc-500'
              : 'border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-md hover:border-zinc-300 dark:hover:border-zinc-700'
        }`}
      >
        <Link
          to={`/tasks/${task.id}`}
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="block p-3.5 pr-8 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 dark:focus-visible:ring-zinc-500/70"
        >
          <TaskCardBody task={task} run={run} />
        </Link>
        <button
          type="button"
          onPointerDown={stopPropagation}
          onMouseDown={stopPropagation}
          onClick={handleMenuButtonClick}
          aria-label={`Actions for ${task.title}`}
          aria-haspopup="menu"
          aria-expanded={contextMenu !== null}
          title="Task actions"
          className="absolute right-2 top-2 h-7 w-7 cursor-pointer inline-flex items-center justify-center rounded-md border border-transparent bg-white/85 text-zinc-400 hover:text-zinc-700 hover:border-zinc-200 hover:bg-white dark:bg-zinc-900/85 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 dark:focus-visible:ring-zinc-500/70 transition-[background-color,border-color,color,opacity]"
        >
          <MoreHorizontal size={17} strokeWidth={2.5} />
        </button>
      </div>
      {contextMenu && (
        <TaskContextMenu
          task={task}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </>
  );
}

export function TaskCardOverlay({ task, run }: { task: Task; run?: TaskRunState }) {
  return (
    <div className="p-3.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-600 shadow-2xl rotate-[2deg] scale-105 w-[280px] pointer-events-none">
      <TaskCardBody task={task} run={run} />
    </div>
  );
}

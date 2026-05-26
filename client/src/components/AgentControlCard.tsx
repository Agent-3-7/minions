import { useCallback, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import {
  Loader2,
  MoreHorizontal,
  Target,
  GitBranch,
  Zap,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Layers,
  User,
  BrainCircuit,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Task, TaskRunState, DelegationStatus } from '@shared/types';
import { DELEGATION_STATUSES } from '@shared/types';
import { goalTurnLabel, timeAgo } from '../lib/format';
import { isActiveRun } from '../lib/store';
import { hasUnseenAgentResponse } from '../lib/taskState';
import { TaskContextMenu } from './TaskContextMenu';
import { RenameTitle } from './RenameTitle';

const BUSY_LABELS: Record<string, string> = { compact: 'Compacting...', goal: 'Working toward goal...' };

const DELEGATION_META: Record<DelegationStatus, { label: string; icon: React.ReactNode; tint: string }> = {
  queued: { label: 'Queued', icon: <Clock size={10} strokeWidth={2.5} />, tint: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
  running: { label: 'Running', icon: <Loader2 size={10} strokeWidth={2.5} className="animate-spin" />, tint: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' },
  review: { label: 'In review', icon: <CheckCircle2 size={10} strokeWidth={2.5} />, tint: 'bg-purple-50 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300' },
  blocked: { label: 'Blocked', icon: <AlertTriangle size={10} strokeWidth={2.5} />, tint: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' },
  done: { label: 'Done', icon: <CheckCircle2 size={10} strokeWidth={2.5} />, tint: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' },
};

function PriorityBadge({ priority }: { priority: number | null }) {
  if (priority == null) return null;
  const color =
    priority >= 4 ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' :
    priority >= 2 ? 'bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300' :
    'bg-zinc-50 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
  return (
    <span className={`inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${color}`}>
      <Zap size={9} strokeWidth={2.5} className="mr-0.5" />
      P{priority}
    </span>
  );
}

function LabelChips({ labelsJson }: { labelsJson: string | null }) {
  if (!labelsJson) return null;
  let labels: string[] = [];
  try { labels = JSON.parse(labelsJson); } catch { /* ignore invalid JSON */ }
  if (!labels.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {labels.slice(0, 3).map((label) => (
        <span key={label} className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">
          {label}
        </span>
      ))}
      {labels.length > 3 && (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
          +{labels.length - 3}
        </span>
      )}
    </div>
  );
}

function ModelHint({ model }: { model: string | null }) {
  if (!model) return null;
  const short = model.includes('/') ? model.split('/').pop() ?? model : model;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500 truncate" title={model}>
      <BrainCircuit size={10} strokeWidth={2.5} />
      {short}
    </span>
  );
}

function AgentRunLine({ task, run }: { task: Task; run?: TaskRunState }) {
  const isUnseen = hasUnseenAgentResponse(task);
  const isBusy = !!run && isActiveRun(run);
  const isGoalRun = run?.kind === 'goal' && run.status === 'streaming';
  const compactGoalLabel = isGoalRun ? goalTurnLabel(run.goal?.turnsUsed ?? 0, run.goal?.maxTurns ?? 0, true) : null;
  const busyLabel = (run?.kind && BUSY_LABELS[run.kind]) || 'Working...';
  const showBusyState = isBusy && !isGoalRun;
  const timeClass = showBusyState
    ? 'font-semibold text-zinc-600 dark:text-zinc-300'
    : isUnseen
      ? 'font-semibold text-zinc-700 dark:text-zinc-200'
      : 'text-zinc-400 dark:text-zinc-500';

  return (
    <div className={`flex min-w-0 flex-1 items-center gap-1.5 text-[11px] leading-none ${timeClass}`}>
      {showBusyState ? (
        <Loader2 size={12} className="shrink-0 animate-spin" strokeWidth={2.5} />
      ) : isUnseen ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-700 ring-4 ring-zinc-100 dark:bg-zinc-200 dark:ring-zinc-800" />
      ) : null}
      <span className="truncate">{showBusyState ? busyLabel : timeAgo(task.updated_at)}</span>
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
  );
}

function SubissueProgress({ task }: { task: Task }) {
  const count = task.child_count ?? 0;
  if (count === 0) return null;

  const doneCount = 0; // computed from subissues data if available; placeholder for now
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      <GitBranch size={11} strokeWidth={2} />
      <span className="font-medium">{count}</span>
      <span className="text-zinc-400 dark:text-zinc-500">sub</span>
      {doneCount > 0 && (
        <>
          <span className="mx-0.5 text-zinc-300 dark:text-zinc-700">|</span>
          <span>{doneCount}/{count} done</span>
        </>
      )}
    </div>
  );
}

export function AgentControlCard({ task, run }: { task: Task; run?: TaskRunState }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id: task.id, data: { task } });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const isUnseen = hasUnseenAgentResponse(task);
  const delegation = task.delegation_status;

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleMenuButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu((current) => (current ? null : { x: rect.left, y: rect.bottom + 6 }));
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const stopPropagation = useCallback((e: { stopPropagation(): void }) => {
    e.stopPropagation();
  }, []);

  const dragClasses = isDragging
    ? 'opacity-30 border-dashed border-zinc-300 dark:border-zinc-600 shadow-none'
    : isUnseen
      ? 'border-zinc-400 dark:border-zinc-600 shadow-lg hover:shadow-xl hover:border-zinc-400 dark:hover:border-zinc-500'
      : 'border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-md hover:border-zinc-300 dark:hover:border-zinc-700';

  return (
    <>
      <div
        ref={setNodeRef}
        onContextMenu={handleContextMenu}
        className={`group/card relative rounded-lg bg-white dark:bg-zinc-900 border cursor-grab active:cursor-grabbing select-none transition-[opacity,box-shadow,border-color] duration-150 ${dragClasses}`}
      >
        {delegation && DELEGATION_STATUSES.includes(delegation) && (
          <div className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full">
            <div className={`h-full w-full rounded-full ${
              delegation === 'running' ? 'bg-amber-500' :
              delegation === 'blocked' ? 'bg-red-500' :
              delegation === 'done' ? 'bg-emerald-500' :
              delegation === 'review' ? 'bg-purple-500' :
              'bg-zinc-400'
            }`} />
          </div>
        )}

        <Link
          to={`/tasks/${task.id}`}
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="block p-3.5 pr-8 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 dark:focus-visible:ring-zinc-500/70"
        >
          <div className="flex flex-col gap-2">
            {/* Top row: meta pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              <PriorityBadge priority={task.priority} />
              <LabelChips labelsJson={task.labels_json} />
              {delegation && DELEGATION_STATUSES.includes(delegation) && (
                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${DELEGATION_META[delegation].tint}`}>
                  {DELEGATION_META[delegation].icon}
                  {DELEGATION_META[delegation].label}
                </span>
              )}
            </div>

            {/* Title */}
            <RenameTitle
              value={task.title}
              identity={task.id}
              className={`block text-sm text-zinc-900 dark:text-zinc-100 line-clamp-2 ${
                isUnseen ? 'font-semibold' : 'font-medium'
              }`}
            />

            {/* Description */}
            {task.description && (
              <p className={`text-xs line-clamp-1 ${
                isUnseen
                  ? 'text-zinc-600 dark:text-zinc-300'
                  : 'text-zinc-500 dark:text-zinc-400'
              }`}>
                {task.description}
              </p>
            )}

            {/* Bottom row: subissues + run info + model */}
            <div className="flex flex-col gap-1.5 mt-0.5">
              <div className="flex items-center justify-between gap-2">
                <AgentRunLine task={task} run={run} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <SubissueProgress task={task} />
                  {task.assignee && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                      <User size={10} strokeWidth={2.5} />
                      {task.assignee}
                    </span>
                  )}
                </div>
                <ModelHint model={task.agent_model} />
              </div>
            </div>
          </div>
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

export function AgentControlCardOverlay({ task, run }: { task: Task; run?: TaskRunState }) {
  const delegation = task.delegation_status;
  return (
    <div className="flex flex-col gap-2 p-3.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-600 shadow-2xl rotate-[2deg] scale-105 w-[280px] pointer-events-none">
      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={task.priority} />
        <LabelChips labelsJson={task.labels_json} />
        {delegation && (
          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${DELEGATION_META[delegation].tint}`}>
            {DELEGATION_META[delegation].icon}
            {DELEGATION_META[delegation].label}
          </span>
        )}
      </div>
      <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2">
        {task.title}
      </span>
      {task.description && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-1">
          {task.description}
        </p>
      )}
    </div>
  );
}

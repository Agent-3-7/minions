import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { MoreHorizontal, Trash2, Loader2, Pencil } from 'lucide-react';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { StatusIcon } from './StatusIcon';
import { useStore, optimisticMoveTask } from '../lib/store';
import { deleteTask, patchTask, moveTask, markTaskViewed } from '../lib/api';
import { TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { timeAgo } from '../lib/format';
import { isEditableTarget } from '../lib/keyboard';
import { TaskChat } from './TaskChat';
import type { AgentRunSettings } from '../lib/api';
import type { TaskStatus } from '@shared/types';

const DETAIL_COLUMN_CLASS = 'max-w-[808px] w-full mx-auto';

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { initialMessage?: string; initialSettings?: AgentRunSettings } | null;
  const initialMessage = locationState?.initialMessage;
  const initialSettings = locationState?.initialSettings;
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId) ?? null);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);

  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipNextTitleSaveRef = useRef(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const markViewedInFlightRef = useRef<string | null>(null);

  useEffect(() => {
    if (task) setTitleDraft(task.title);
  }, [task?.id, task?.title]);

  useEffect(() => {
    if (!task || task.last_agent_response_at === null) return;
    if (task.last_viewed_at !== null && task.last_viewed_at >= task.last_agent_response_at) return;

    const key = `${task.id}:${task.last_agent_response_at}`;
    if (markViewedInFlightRef.current === key) return;
    markViewedInFlightRef.current = key;

    markTaskViewed(task.id)
      .then(({ task: updated }) => upsertTask(updated))
      .catch(() => {})
      .finally(() => {
        if (markViewedInFlightRef.current === key) {
          markViewedInFlightRef.current = null;
        }
      });
  }, [task?.id, task?.last_agent_response_at, task?.last_viewed_at, upsertTask]);

  useEffect(() => {
    if (initialMessage || initialSettings) {
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [taskId, initialMessage, initialSettings, navigate, location.pathname]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e)) navigate('/');
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  useEffect(() => {
    if (!showMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  const handleTitleSave = useCallback(async () => {
    if (!task) return;
    if (skipNextTitleSaveRef.current) {
      skipNextTitleSaveRef.current = false;
      setTitleDraft(task.title);
      return;
    }

    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      try {
        const { task: updated } = await patchTask(task.id, { title: trimmed });
        upsertTask(updated);
      } catch {
        setTitleDraft(task.title);
      }
    } else {
      setTitleDraft(task.title);
    }
  }, [task, titleDraft, upsertTask]);

  const handleStatusChange = useCallback(async (status: TaskStatus) => {
    if (!task) return;
    setShowMenu(false);
    await optimisticMoveTask(task, status, upsertTask, moveTask);
  }, [task, upsertTask]);

  const handleDelete = useCallback(async () => {
    if (!task) return;
    try {
      await deleteTask(task.id);
      removeTask(task.id);
      navigate('/');
    } catch {}
  }, [task, removeTask, navigate]);

  if (!task) {
    if (!tasksLoaded) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-zinc-400" />
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-400 dark:text-zinc-500">Task not found</p>
      </div>
    );
  }

  const statusMeta = STATUS_META[task.status];
  const titleMeasureText = titleDraft || 'Name this task';

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className={`${DETAIL_COLUMN_CLASS} px-4 sm:px-6 pt-7 pb-2`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="-ml-2 inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-zinc-100/80 focus-within:bg-white focus-within:ring-1 focus-within:ring-zinc-200 dark:hover:bg-zinc-800/80 dark:focus-within:bg-zinc-900 dark:focus-within:ring-zinc-700">
              <div className="relative min-w-[8ch] max-w-[calc(100%-1.75rem)] shrink overflow-hidden">
                <span
                  aria-hidden="true"
                  className="invisible block truncate whitespace-pre text-xl font-semibold leading-8"
                >
                  {titleMeasureText}
                </span>
                <input
                  ref={titleInputRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      titleInputRef.current?.blur();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      skipNextTitleSaveRef.current = true;
                      setTitleDraft(task.title);
                      titleInputRef.current?.blur();
                    }
                  }}
                  aria-label="Task title"
                  placeholder="Name this task"
                  className="absolute inset-0 h-full w-full cursor-text bg-transparent px-0 py-0 text-xl font-semibold leading-8 text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                />
              </div>
              <button
                type="button"
                title="Rename task"
                aria-label="Rename task"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  titleInputRef.current?.focus();
                  titleInputRef.current?.select();
                }}
                className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              >
                <Pencil size={15} />
              </button>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2.5 sm:pt-1.5">
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${statusMeta.tint}`}>
              <StatusIcon status={task.status} />
              {statusMeta.label}
            </span>

            <span className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0">
              {timeAgo(task.updated_at)}
            </span>

            <div className="relative shrink-0">
              <button
                onClick={() => setShowMenu(!showMenu)}
                className="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <MoreHorizontal size={16} />
              </button>
              {showMenu && (
                <div ref={menuRef} className="absolute right-0 top-full mt-1 min-w-[180px] py-1 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-xl z-50">
                  <p className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                    Move to
                  </p>
                  {TASK_STATUSES.filter((s) => s !== task.status).map((status) => (
                    <button
                      key={status}
                      onClick={() => handleStatusChange(status)}
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
                    >
                      <StatusIcon status={status} />
                      {STATUS_META[status].label}
                    </button>
                  ))}
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                  <button
                    onClick={() => { setShowMenu(false); setShowDeleteConfirm(true); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left"
                  >
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="w-full flex-1 flex flex-col min-h-0">
        <TaskChat taskId={task.id} initialMessage={initialMessage} initialSettings={initialSettings} />
      </div>

      {showDeleteConfirm && (
        <DeleteConfirmModal
          onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

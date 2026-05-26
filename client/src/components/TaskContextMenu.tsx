import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, GitBranch, Sparkles, Link as LinkIcon, ListTree } from 'lucide-react';
import type { Task, TaskStatus } from '@shared/types';
import { TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { StatusIcon } from './StatusIcon';
import { useStore, optimisticMoveTask } from '../lib/store';
import { moveTask, deleteTask } from '../lib/api';
import { CreateSubtaskModal } from './CreateSubtaskModal';

interface Props {
  task: Task;
  x: number;
  y: number;
  onClose: () => void;
}

export function TaskContextMenu({ task, x, y, onClose }: Props) {
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showSubtaskModal, setShowSubtaskModal] = useState(false);
  const [subtaskDelegate, setSubtaskDelegate] = useState(false);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const clampedX = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 8 : x;
    const clampedY = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 8 : y;
    if (clampedX !== x || clampedY !== y) {
      setPos({ x: clampedX, y: clampedY });
    }
  }, [x, y]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (showDeleteConfirm || showSubtaskModal) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, showDeleteConfirm, showSubtaskModal]);

  async function handleMove(status: TaskStatus) {
    onClose();
    await optimisticMoveTask(task, status, upsertTask, moveTask);
  }

  async function handleDelete() {
    onClose();
    try {
      await deleteTask(task.id);
      removeTask(task.id);
    } catch {}
  }

  function handleCopyLink() {
    const url = `${window.location.origin}/tasks/${task.id}`;
    navigator.clipboard.writeText(url).catch(() => {});
    onClose();
  }

  const otherStatuses = TASK_STATUSES.filter((s) => s !== task.status);

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 min-w-[220px] py-1 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 shadow-xl animate-in fade-in zoom-in-95 duration-100"
      >
        <p className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
          Move to
        </p>
        {otherStatuses.map((status) => (
          <button
            key={status}
            type="button"
            role="menuitem"
            onClick={() => handleMove(status)}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
          >
            <StatusIcon status={status} />
            {STATUS_META[status].label}
          </button>
        ))}
        <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />

        <p className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
          Actions
        </p>
        <button
          type="button"
          role="menuitem"
          onClick={() => { setSubtaskDelegate(false); setShowSubtaskModal(true); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
        >
          <GitBranch size={14} strokeWidth={2} />
          Create subtask
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => { setSubtaskDelegate(true); setShowSubtaskModal(true); }}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
        >
          <Sparkles size={14} strokeWidth={2} />
          Delegate subtask
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={handleCopyLink}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
        >
          <LinkIcon size={14} strokeWidth={2} />
          Copy link
        </button>

        <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
        <button
          type="button"
          role="menuitem"
          onClick={() => setShowDeleteConfirm(true)}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-left"
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>

      {showDeleteConfirm && (
        <DeleteConfirmModal onConfirm={handleDelete} onCancel={() => setShowDeleteConfirm(false)} zIndex={60} />
      )}
      {showSubtaskModal && (
        <CreateSubtaskModal
          parent={task}
          initialDelegate={subtaskDelegate}
          onClose={() => setShowSubtaskModal(false)}
        />
      )}
    </>,
    document.body,
  );
}

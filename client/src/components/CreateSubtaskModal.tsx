import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, GitBranch, Sparkles } from 'lucide-react';
import { createSubtask } from '../lib/api';
import { useStore } from '../lib/store';
import type { Task } from '@shared/types';

interface Props {
  parent: Task;
  onClose: () => void;
}

export function CreateSubtaskModal({ parent, onClose, initialDelegate = false }: Props & { initialDelegate?: boolean }) {
  const upsertTask = useStore((s) => s.upsertTask);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [delegate, setDelegate] = useState(initialDelegate);
  const [priority, setPriority] = useState<number | ''>('');
  const [labels, setLabels] = useState('');
  const [assignee, setAssignee] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const res = await createSubtask(parent.id, {
        title: trimmed,
        description: description.trim() || undefined,
        delegate,
        priority: priority === '' ? undefined : Number(priority),
        labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
        assignee: assignee.trim() || undefined,
      });
      if (res.parent) upsertTask(res.parent);
      for (const sub of res.subtasks) {
        upsertTask(sub);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create subtask');
    } finally {
      setLoading(false);
    }
  }, [title, description, delegate, priority, labels, assignee, parent.id, onClose, upsertTask]);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 dark:bg-black/60">
      <div className="w-full max-w-md mx-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-2xl">
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
            <GitBranch size={15} strokeWidth={2} />
            New subtask
          </h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Title</label>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400/60 dark:focus:ring-zinc-500/70"
              placeholder="What should the subtask do?"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400/60 dark:focus:ring-zinc-500/70 resize-none"
              placeholder="Optional details..."
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Priority (0-5)</label>
              <input
                type="number"
                min={0}
                max={5}
                value={priority}
                onChange={(e) => setPriority(e.target.value === '' ? '' : parseInt(e.target.value))}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400/60"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Assignee</label>
              <input
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400/60"
                placeholder="e.g., kimi-ui"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Labels (comma-separated)</label>
            <input
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400/60"
              placeholder="frontend, urgent"
            />
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2">
            <input
              id="sub-delegate"
              type="checkbox"
              checked={delegate}
              onChange={(e) => setDelegate(e.target.checked)}
              className="h-4 w-4 accent-zinc-900 dark:accent-zinc-100"
            />
            <label htmlFor="sub-delegate" className="text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer flex items-center gap-1.5">
              <Sparkles size={13} strokeWidth={2} />
              Delegate to Hermes agent
            </label>
          </div>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-md px-3.5 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 disabled:opacity-50 transition-colors"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              Create subtask
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

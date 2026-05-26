interface Props {
  onConfirm: () => void;
  onCancel: () => void;
  zIndex?: number;
  title?: string;
  body?: string;
  confirmLabel?: string;
  isConfirming?: boolean;
  error?: string | null;
}

export function DeleteConfirmModal({
  onConfirm,
  onCancel,
  zIndex = 50,
  title = 'Delete task',
  body = 'This removes the task from AgentControl. The Hermes session history remains in Hermes.',
  confirmLabel = 'Delete',
  isConfirming = false,
  error = null,
}: Props) {
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex }}>
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-xl px-6 py-5 w-full max-w-sm mx-4">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400">
          {body}
        </p>
        {error && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            onClick={onCancel}
            disabled={isConfirming}
            className="px-3.5 py-1.5 text-sm font-medium rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isConfirming}
            className="px-3.5 py-1.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {isConfirming ? 'Deleting...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

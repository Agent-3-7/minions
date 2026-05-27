import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import { MoreHorizontal, Trash2, Loader2, Pencil, Check, GitBranch, AlertTriangle, CheckCircle2, Clock, ArrowRight, MessageSquareText, X, Activity, ExternalLink, GitPullRequest } from 'lucide-react';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { StatusIcon } from './StatusIcon';
import { useStore, optimisticMoveTask } from '../lib/store';
import { toast } from 'sonner';
import { deleteTask, fetchSubtasks, fetchTask, fetchTaskKanban, fetchTaskKanbanLogs, fetchTaskGitHubStatus, refreshTaskGitHubStatus, patchTask, moveTask, markTaskViewed } from '../lib/api';
import { DELEGATION_STATUSES, TASK_STATUSES } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { timeAgo } from '../lib/format';
import { isEditableTarget } from '../lib/keyboard';
import { TaskChat } from './TaskChat';
import { RenameReveal, useRenameAnimation } from './RenameTitle';
import type { AgentRunSettings } from '../lib/api';
import type { DelegationStatus, KanbanLogsResponse, KanbanTaskResponse, Task, TaskStatus } from '@shared/types';


const DELEGATION_META: Record<DelegationStatus, { label: string; icon: React.ReactNode; tint: string }> = {
  queued: { label: 'Queued', icon: <Clock size={11} strokeWidth={2.5} />, tint: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300' },
  running: { label: 'Running', icon: <Loader2 size={11} strokeWidth={2.5} className="animate-spin" />, tint: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300' },
  review: { label: 'In review', icon: <CheckCircle2 size={11} strokeWidth={2.5} />, tint: 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900/70 dark:bg-purple-950/30 dark:text-purple-300' },
  blocked: { label: 'Blocked', icon: <AlertTriangle size={11} strokeWidth={2.5} />, tint: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300' },
  done: { label: 'Done', icon: <CheckCircle2 size={11} strokeWidth={2.5} />, tint: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300' },
};

const GITHUB_CHECK_TINTS: Record<string, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300',
  failure: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300',
  pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300',
  unknown: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
};

interface GitHubStatusState {
  prUrl: string | null;
  prNumber: number | null;
  prState: string | null;
  headRef: string | null;
  headSha: string | null;
  checksStatus: string | null;
  checksSummary: string | null;
  checksUpdatedAt: number | null;
  refreshing: boolean;
  syncError: string | null;
}

function DelegationBadge({ status }: { status: DelegationStatus | null }) {
  if (!status || !DELEGATION_STATUSES.includes(status)) return null;
  const meta = DELEGATION_META[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
      {meta.icon}
      {meta.label}
    </span>
  );
}

function formatPayload(payload: Record<string, unknown>): string {
  const compact = JSON.stringify(payload);
  if (!compact || compact === '{}') return '—';
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function KanbanPanel({ info, logs }: { info: KanbanTaskResponse | null; logs: KanbanLogsResponse | null }) {
  if (!info?.kanban_id) return null;
  const kanban = info.kanban;
  const latestRun = logs?.runs?.[0] ?? null;
  const latestComment = logs?.comments?.[0] ?? null;
  const eventRows = logs?.logs ?? [];

  return (
    <section className="border-b border-zinc-200 bg-zinc-50/50 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-950/40 sm:px-6">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          <Activity size={13} strokeWidth={2.5} />
          Hermes Kanban
        </span>
        <span className="rounded-md bg-zinc-200 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
          {info.kanban_id}
        </span>
        {(kanban?.assignee || info.delegation_profile) && (
          <span className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            Profile: {kanban?.assignee ?? info.delegation_profile}
          </span>
        )}
        {kanban?.status && (
          <span className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
            {kanban.status}
          </span>
        )}
        {latestRun?.status && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Run #{latestRun.run_id}: {latestRun.status}</span>}
      </div>
      {kanban?.summary && (
        <p className="mb-2 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-300">{kanban.summary}</p>
      )}
      {latestComment && (
        <p className="mb-2 line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">
          Latest comment by {latestComment.author}: {latestComment.body}
        </p>
      )}
      <div className="max-h-28 overflow-y-auto rounded-md border border-zinc-200 bg-white/80 dark:border-zinc-800 dark:bg-zinc-900/70">
        {eventRows.length > 0 ? eventRows.slice(0, 8).map((entry) => (
          <div key={entry.log_id} className="border-b border-zinc-100 px-2 py-1.5 text-[11px] last:border-b-0 dark:border-zinc-800">
            <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-200">{entry.event_kind}</span>
            {entry.run_id && <span className="ml-1 text-zinc-400">run #{entry.run_id}</span>}
            <span className="ml-2 font-mono text-zinc-500 dark:text-zinc-400">{formatPayload(entry.payload)}</span>
          </div>
        )) : (
          <div className="px-2 py-2 text-[11px] text-zinc-400 dark:text-zinc-500">No Kanban events yet.</div>
        )}
      </div>
    </section>
  );
}

function GitHubPanel({ status, onRefresh }: { status: GitHubStatusState; onRefresh: () => void }) {
  if (!status.prNumber && !status.prUrl && !status.checksStatus) return null;

  const prStateLabel = status.prState ? (status.prState === 'OPEN' ? 'Open' : status.prState === 'MERGED' ? 'Merged' : 'Closed') : null;
  const checkTint = GITHUB_CHECK_TINTS[status.checksStatus ?? 'unknown'] ?? GITHUB_CHECK_TINTS.unknown;

  return (
    <section className="border-b border-zinc-200 bg-zinc-50/50 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-950/40 sm:px-6">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          <GitPullRequest size={13} strokeWidth={2.5} />
          GitHub
        </span>
        {status.prNumber && (
          <span className="rounded-md bg-zinc-200 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
            PR #{status.prNumber}
          </span>
        )}
        {prStateLabel && (
          <span className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            {prStateLabel}
          </span>
        )}
        {status.checksStatus && (
          <span className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${checkTint}`}>
            {status.checksStatus}
          </span>
        )}
        {status.refreshing ? (
          <Loader2 size={12} className="animate-spin text-zinc-400" />
        ) : (
          <button
            onClick={onRefresh}
            title="Refresh GitHub status"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          >
            <Activity size={11} strokeWidth={2.5} />
            Sync
          </button>
        )}
        {status.prUrl && (
          <a
            href={status.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          >
            <ExternalLink size={11} strokeWidth={2.5} />
            Open
          </a>
        )}
      </div>
      {status.checksSummary && (
        <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-300">{status.checksSummary}</p>
      )}
      {status.headRef && (
        <p className="mb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          Branch: <span className="font-mono font-semibold">{status.headRef}</span>
          {status.headSha && <span className="ml-1 font-mono text-zinc-400">({status.headSha.slice(0, 7)})</span>}
        </p>
      )}
      {status.syncError && (
        <p className="text-[11px] text-red-500 dark:text-red-400">{status.syncError}</p>
      )}
    </section>
  );
}

function SubtaskRow({ subtask }: { subtask: Task }) {
  const statusMeta = STATUS_META[subtask.status];
  return (
    <Link
      to={`/tasks/${subtask.id}`}
      className="group block rounded-lg border border-zinc-200 bg-white p-3 transition-[border-color,box-shadow] hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/90 dark:hover:border-zinc-700"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.tint}`}>
          <StatusIcon status={subtask.status} />
          {statusMeta.label}
        </span>
        <DelegationBadge status={subtask.delegation_status} />
      </div>
      <div className="line-clamp-2 text-xs font-semibold leading-5 text-zinc-900 group-hover:text-zinc-950 dark:text-zinc-100 dark:group-hover:text-white">
        {subtask.title}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500">
        <span>{timeAgo(subtask.updated_at)}</span>
        <span className="inline-flex items-center gap-0.5 font-medium text-zinc-500 group-hover:text-zinc-700 dark:text-zinc-400 dark:group-hover:text-zinc-200">
          <MessageSquareText size={10} strokeWidth={2.5} />
          Open
          <ArrowRight size={10} strokeWidth={2.5} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}

function SubtasksSidebar({ subtasks }: { subtasks: Task[] }) {
  const doneCount = subtasks.filter((s) => s.status === 'done').length;
  const runningCount = subtasks.filter((s) => s.delegation_status === 'running').length;
  const blockedCount = subtasks.filter((s) => s.delegation_status === 'blocked').length;
  const progress = Math.round((doneCount / subtasks.length) * 100);

  return (
    <aside className="hidden lg:flex w-72 xl:w-80 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-950/30">
      <div className="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <GitBranch size={12} strokeWidth={2.5} />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Subtasks</span>
          <span className="ml-auto rounded-full bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
            {subtasks.length}
          </span>
        </div>
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="font-medium">{doneCount}/{subtasks.length} done</span>
          <div className="flex items-center gap-2">
            {runningCount > 0 && <span className="text-amber-600 dark:text-amber-400">{runningCount} running</span>}
            {blockedCount > 0 && <span className="text-red-500 dark:text-red-400">{blockedCount} blocked</span>}
          </div>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out dark:bg-emerald-400"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <div className="flex flex-col gap-2">
          {subtasks.map((subtask) => (
            <SubtaskRow key={subtask.id} subtask={subtask} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function SubtasksSlideover({ subtasks, onClose }: { subtasks: Task[]; onClose: () => void }) {
  const doneCount = subtasks.filter((s) => s.status === 'done').length;
  const runningCount = subtasks.filter((s) => s.delegation_status === 'running').length;
  const blockedCount = subtasks.filter((s) => s.delegation_status === 'blocked').length;
  const progress = Math.round((doneCount / subtasks.length) * 100);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col lg:hidden">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative ml-auto flex h-full w-full max-w-sm flex-col border-l border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <GitBranch size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Subtasks</span>
            <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
              {subtasks.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>
        <div className="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="font-medium">{doneCount}/{subtasks.length} done</span>
            <div className="flex items-center gap-2">
              {runningCount > 0 && <span className="text-amber-600 dark:text-amber-400">{runningCount} running</span>}
              {blockedCount > 0 && <span className="text-red-500 dark:text-red-400">{blockedCount} blocked</span>}
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-300 ease-out dark:bg-emerald-400"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <div className="flex flex-col gap-2.5">
            {subtasks.map((subtask) => (
              <SubtaskRow key={subtask.id} subtask={subtask} />
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}


export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { initialMessage?: string; initialSettings?: AgentRunSettings } | null;
  const initialMessage = locationState?.initialMessage;
  const initialSettings = locationState?.initialSettings;
  const task = useStore((s) => s.tasks.find((t) => t.id === taskId) ?? null);
  const tasks = useStore((s) => s.tasks);
  const tasksLoaded = useStore((s) => s.tasksLoaded);
  const upsertTask = useStore((s) => s.upsertTask);
  const removeTask = useStore((s) => s.removeTask);
  const allSubtasks = useStore((s) => (taskId ? s.subtasksByParent.get(taskId) : undefined));
  const subtasks = useMemo(() => allSubtasks ?? [], [allSubtasks]);
  const setSubtasks = useStore((s) => s.setSubtasks);

  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const skipNextTitleSaveRef = useRef(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showSubtasksSlideover, setShowSubtasksSlideover] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const markViewedInFlightRef = useRef<string | null>(null);
  const [detailFetchInFlight, setDetailFetchInFlight] = useState(false);
  const [detailFetchFailed, setDetailFetchFailed] = useState(false);
  const [kanbanInfo, setKanbanInfo] = useState<KanbanTaskResponse | null>(null);
  const [kanbanLogs, setKanbanLogs] = useState<KanbanLogsResponse | null>(null);
  const [githubStatus, setGitHubStatus] = useState<GitHubStatusState>({
    prUrl: null,
    prNumber: null,
    prState: null,
    headRef: null,
    headSha: null,
    checksStatus: null,
    checksSummary: null,
    checksUpdatedAt: null,
    refreshing: false,
    syncError: null,
  });
  const titleAnimation = useRenameAnimation(task?.title ?? '', task?.id ?? null);

  useEffect(() => {
    if (!taskId || task || !tasksLoaded) {
      setDetailFetchInFlight(false);
      setDetailFetchFailed(false);
      return;
    }

    let cancelled = false;
    setDetailFetchInFlight(true);
    setDetailFetchFailed(false);

    fetchTask(taskId)
      .then(({ task: fetchedTask }) => {
        if (!cancelled) upsertTask(fetchedTask);
      })
      .catch(() => {
        if (!cancelled) setDetailFetchFailed(true);
      })
      .finally(() => {
        if (!cancelled) setDetailFetchInFlight(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId, task, tasksLoaded, upsertTask]);

  useEffect(() => {
    if (!task?.parent_task_id) return;
    if (tasks.some((candidate) => candidate.id === task.parent_task_id)) return;

    let cancelled = false;
    fetchTask(task.parent_task_id)
      .then(({ task: parentTask }) => {
        if (!cancelled) upsertTask(parentTask);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [task?.parent_task_id, tasks, upsertTask]);

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
    if (!task || task.parent_task_id) return;
    let cancelled = false;
    fetchSubtasks(task.id)
      .then((res) => {
        if (!cancelled) setSubtasks(task.id, res.subtasks);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task?.id, task?.parent_task_id, setSubtasks]);

  useEffect(() => {
    if (!task?.hermes_kanban_task_id) {
      setKanbanInfo(null);
      setKanbanLogs(null);
      return;
    }

    let cancelled = false;
    function refreshKanban() {
      if (!task) return;
      Promise.all([
        fetchTaskKanban(task.id),
        fetchTaskKanbanLogs(task.id, 50),
      ])
        .then(([info, logs]) => {
          if (!cancelled) {
            setKanbanInfo(info);
            setKanbanLogs(logs);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setKanbanInfo(null);
            setKanbanLogs(null);
          }
        });
    }

    refreshKanban();
    const timer = window.setInterval(refreshKanban, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [task?.id, task?.hermes_kanban_task_id]);

  // GitHub status: seed from task fields on load, allow manual refresh
  useEffect(() => {
    if (!task) return;
    setGitHubStatus((prev) => ({
      ...prev,
      prUrl: task.github_pr_url ?? prev.prUrl,
      prNumber: task.github_pr_number ?? prev.prNumber,
      prState: task.github_pr_state ?? prev.prState,
      headRef: task.github_pr_head_ref ?? prev.headRef,
      headSha: task.github_pr_head_sha ?? prev.headSha,
      checksStatus: task.github_checks_status ?? prev.checksStatus,
      checksSummary: task.github_checks_summary ?? prev.checksSummary,
      checksUpdatedAt: task.github_checks_updated_at ?? prev.checksUpdatedAt,
    }));
  }, [task?.github_pr_url, task?.github_pr_number, task?.github_pr_state, task?.github_pr_head_ref, task?.github_pr_head_sha, task?.github_checks_status, task?.github_checks_summary, task?.github_checks_updated_at]);

  const handleRefreshGitHub = useCallback(async () => {
    if (!taskId) return;
    setGitHubStatus((prev) => ({ ...prev, refreshing: true, syncError: null }));
    try {
      const data = await refreshTaskGitHubStatus(taskId);
      setGitHubStatus({
        prUrl: data.github_pr_url ?? null,
        prNumber: data.github_pr_number ?? null,
        prState: data.github_pr_state ?? null,
        headRef: data.github_pr_head_ref ?? null,
        headSha: data.github_pr_head_sha ?? null,
        checksStatus: data.github_checks_status ?? null,
        checksSummary: data.github_checks_summary ?? null,
        checksUpdatedAt: data.github_checks_updated_at ?? null,
        refreshing: false,
        syncError: data.error ?? null,
      });
      if (data.github_pr_url || data.github_checks_status) {
        toast('GitHub status synced', {
          icon: <GitPullRequest size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />,
        });
      }
    } catch (err) {
      setGitHubStatus((prev) => ({
        ...prev,
        refreshing: false,
        syncError: err instanceof Error ? err.message : 'Sync failed',
      }));
    }
  }, [taskId]);

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
    if (status === 'done') {
      const previousStatus = task.status;
      const taskId = task.id;
      optimisticMoveTask(task, 'done', upsertTask, moveTask);
      navigate('/');
      toast('Task completed', {
        icon: <Check size={14} strokeWidth={2.5} className="text-zinc-500 dark:text-zinc-400" />,
        action: {
          label: 'Undo',
          onClick: () => {
            const { tasks, upsertTask: storeUpsert } = useStore.getState();
            const current = tasks.find((t) => t.id === taskId);
            if (current) optimisticMoveTask(current, previousStatus, storeUpsert, moveTask);
          },
        },
      });
    } else {
      await optimisticMoveTask(task, status, upsertTask, moveTask);
    }
  }, [task, upsertTask, navigate]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isEditableTarget(e.target)) navigate('/');
      if (e.key === 'd' && e.metaKey && e.shiftKey && task && task.status !== 'done') {
        e.preventDefault();
        handleStatusChange('done');
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navigate, task, handleStatusChange]);

  const handleDelete = useCallback(async () => {
    if (!task) return;
    try {
      await deleteTask(task.id);
      removeTask(task.id);
      navigate('/');
    } catch {}
  }, [task, removeTask, navigate]);

  if (!task) {
    if (!tasksLoaded || detailFetchInFlight) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-zinc-400" />
        </div>
      );
    }
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-zinc-400 dark:text-zinc-500">
          {detailFetchFailed ? 'Task not found' : 'Loading task...'}
        </p>
      </div>
    );
  }

  const statusMeta = STATUS_META[task.status];
  const parentTask = task.parent_task_id
    ? tasks.find((candidate) => candidate.id === task.parent_task_id) ?? null
    : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="w-full px-3 pt-3 pb-2 sm:px-6 sm:pt-4 sm:pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="-ml-2 relative w-full rounded-md px-2 py-1 pr-10 transition-colors hover:bg-zinc-100/80 focus-within:bg-white focus-within:ring-1 focus-within:ring-zinc-200 dark:hover:bg-zinc-800/80 dark:focus-within:bg-zinc-900 dark:focus-within:ring-zinc-700">
              <div className="rename-title-shell">
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
                  className={`block w-full cursor-text truncate bg-transparent p-0 text-lg font-semibold leading-7 text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500 sm:text-xl sm:leading-8 ${
                    titleAnimation.isAnimating ? 'rename-title-input-hidden' : ''
                  }`}
                />
                <RenameReveal
                  animation={titleAnimation}
                  className="text-lg font-semibold leading-7 text-zinc-900 dark:text-zinc-100 sm:text-xl sm:leading-8"
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
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              >
                <Pencil size={15} />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2.5 sm:shrink-0 sm:justify-start sm:pt-1.5">
            <div className="flex items-center gap-2.5">
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${statusMeta.tint}`}>
                <StatusIcon status={task.status} />
                {statusMeta.label}
              </span>

              <span className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0">
                {timeAgo(task.updated_at)}
              </span>
              {task.parent_task_id && (
                <span className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                  <GitBranch size={12} strokeWidth={2.5} className="shrink-0" />
                  <span className="shrink-0">Subtask of</span>
                  {parentTask ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/tasks/${parentTask.id}`)}
                      className="min-w-0 truncate font-medium text-zinc-800 underline decoration-zinc-300 underline-offset-2 hover:text-zinc-950 dark:text-zinc-100 dark:decoration-zinc-600 dark:hover:text-white"
                      title={parentTask.title}
                    >
                      {parentTask.title}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate font-mono text-[11px]">{task.parent_task_id}</span>
                  )}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2.5">
              {task.status !== 'done' && (
                <div className="group relative shrink-0">
                  <button
                    onClick={() => handleStatusChange('done')}
                    aria-label="Mark complete"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-zinc-900 p-1.5 text-zinc-100 transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 sm:px-3 sm:py-1.5 sm:text-xs sm:font-semibold"
                  >
                    <Check size={14} strokeWidth={2.5} />
                    <span className="hidden sm:inline">Mark complete</span>
                  </button>
                  <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] text-zinc-500 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 max-sm:hidden">
                    <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-l border-t border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900" />
                    <span className="flex items-center gap-1">
                      {['⌘', '⇧', 'D'].map((k) => (
                        <kbd key={k} className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-zinc-200 bg-zinc-100 px-1 font-sans text-[10px] text-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">{k}</kbd>
                      ))}
                    </span>
                  </div>
                </div>
              )}

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
                    {!task.parent_task_id && subtasks.length > 0 && (
                      <>
                        <p className="px-3 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500 uppercase tracking-wider lg:hidden">
                          Subtasks
                        </p>
                        <button
                          onClick={() => { setShowMenu(false); setShowSubtasksSlideover(true); }}
                          className="lg:hidden w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-left"
                        >
                          <GitBranch size={14} strokeWidth={2} />
                          Subtasks ({subtasks.length})
                        </button>
                        <div className="lg:hidden my-1 border-t border-zinc-200 dark:border-zinc-800" />
                      </>
                    )}
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
      </div>

      <KanbanPanel info={kanbanInfo} logs={kanbanLogs} />
      <GitHubPanel status={githubStatus} onRefresh={handleRefreshGitHub} />

      <div className="w-full flex-1 flex flex-row min-h-0">
        <div className="flex-1 flex flex-col min-h-0">
          <TaskChat taskId={task.id} initialMessage={initialMessage} initialSettings={initialSettings} />
        </div>
        {!task.parent_task_id && subtasks.length > 0 && (
          <SubtasksSidebar subtasks={subtasks} />
        )}
      </div>

      {showSubtasksSlideover && subtasks.length > 0 && (
        <SubtasksSlideover
          subtasks={subtasks}
          onClose={() => setShowSubtasksSlideover(false)}
        />
      )}

      {showDeleteConfirm && (
        <DeleteConfirmModal
          onConfirm={() => { setShowDeleteConfirm(false); handleDelete(); }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

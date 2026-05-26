import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  Newspaper,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Send,
  Trash2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRun, ScheduledTaskRunContent, ScheduledTaskStatus } from '@shared/types';
import {
  createScheduledTask,
  deleteScheduledTask,
  fetchScheduledTask,
  fetchScheduledTaskRunContent,
  fetchScheduledTaskRuns,
  fetchScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  runScheduledTask,
  updateScheduledTask,
} from '../lib/api';
import { formatDate, toErrorMessage } from '../lib/format';
import {
  compileSchedule,
  detectPreset,
  nextRunPreview,
  relativeTime,
  scheduleRaw,
  scheduleSummary,
  type IntervalUnit,
  type SchedulePreset,
} from '../lib/schedule';
import { useAgentConfig } from '../hooks/useAgentConfig';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { usePageHeader, type PageHeaderConfig } from './Header';
import { ModelPicker } from './InputToolbar';
import { MarkdownContent } from './MarkdownContent';

const DEFAULT_PAUSE_REASON = 'Paused from Minions';
const HERMES_DELIVERY_DOCS = 'https://hermes-agent.nousresearch.com/docs/user-guide/features/cron#delivery-options';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RUN_POLL_INTERVAL_MS = 3000;
const RUN_POLL_TIMEOUT_MS = 60_000;
const RUNS_PAGE_SIZE = 50;
const SCHEDULED_TASK_EDITOR_FORM_ID = 'scheduled-task-editor-form';

const ROUTES = {
  list: '/scheduled-tasks',
  new: '/scheduled-tasks/new',
  edit: (id: string) => `/scheduled-tasks/${id}/edit`,
  runs: (id: string) => `/scheduled-tasks/${id}/runs`,
  run: (id: string, runId: string) => `/scheduled-tasks/${id}/runs/${runId}`,
};

type RunFilterMode = 'all' | 'errors';
type RepeatMode = 'forever' | 'once' | 'times';

type PendingAction = {
  action: 'pause' | 'resume' | 'run' | 'delete';
  scheduledTaskId: string;
};

type RunPollState = {
  scheduledTaskId: string;
  previousLatestRunId: string | null;
  startedAt: number;
};

type ScheduledTaskTemplate = {
  key: string;
  name: string;
  description: string;
  icon: LucideIcon;
  prompt: string;
  schedule: string;
};

type ScheduledTaskFormState = {
  name: string;
  prompt: string;
  preset: SchedulePreset;
  time: string;
  weekday: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  rawSchedule: string;
  deliver: string;
  model: string;
  workdir: string;
  repeatMode: RepeatMode;
  repeatCount: string;
};

export const SCHEDULED_TASK_TEMPLATES: ScheduledTaskTemplate[] = [
  {
    key: 'daily-news-digest',
    name: 'Daily news digest',
    description: "Summarize today's headlines for the team",
    icon: Newspaper,
    schedule: '0 9 * * 1-5',
    prompt: `# Goal
Publish a short daily digest of news the team should know.

# Steps
1. Search the web for items published today only.
2. Filter for topics relevant to the team and industry.
3. For each item: 1-line title, source link, 2-sentence takeaway.
4. Compile into a single markdown digest.
5. Save the digest as a single markdown document.`,
  },
  {
    key: 'inbox-triage',
    name: 'Inbox triage',
    description: 'Classify new emails and surface urgent items',
    icon: Mail,
    schedule: 'every 2h',
    prompt: `# Goal
Triage the inbox and flag urgent items.

# Steps
1. List new emails since the last run.
2. Classify each: urgent / informational / promotional / spam.
3. Summarize the urgent items in one paragraph each.
4. Output the digest as a markdown document.`,
  },
];

function scheduledTaskStatusClass(status: ScheduledTaskStatus | null): string {
  if (status === 'ok') return 'text-zinc-700 dark:text-zinc-300';
  if (status === 'error') return 'text-rose-600 dark:text-rose-400';
  return 'text-zinc-500 dark:text-zinc-400';
}

function statusBadgeClass(status: ScheduledTaskStatus | null): string {
  if (status === 'ok') {
    return 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200';
  }
  if (status === 'error') {
    return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300';
  }
  return 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400';
}

function ScheduledTaskStatusIcon({ status }: { status: ScheduledTaskStatus | null }) {
  if (status === 'ok') return <CheckCircle2 size={14} />;
  if (status === 'error') return <XCircle size={14} />;
  return <Clock3 size={14} />;
}

type PillTone = 'neutral' | 'active' | 'status';

function Pill({
  icon,
  children,
  tone = 'neutral',
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: PillTone;
  className?: string;
}) {
  const toneCls = tone === 'active'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
    : 'border-zinc-200 bg-white text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300';
  return (
    <span className={`inline-flex min-h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold ${tone === 'status' ? '' : toneCls} ${className ?? ''}`}>
      {icon}
      {children}
    </span>
  );
}

function ScheduledTaskStatePill({ enabled }: { enabled: boolean }) {
  return (
    <Pill
      tone={enabled ? 'active' : 'neutral'}
      icon={enabled ? <Check size={13} /> : <Pause size={13} />}
      className={enabled ? '' : 'text-zinc-500 dark:text-zinc-400'}
    >
      {enabled ? 'Active' : 'Paused'}
    </Pill>
  );
}

function RunStatusPill({ status }: { status: ScheduledTaskStatus | null }) {
  return (
    <span className={`inline-flex min-h-[24px] items-center gap-1 rounded-full border px-2 text-xs font-semibold ${statusBadgeClass(status)}`}>
      <ScheduledTaskStatusIcon status={status} />
      {status ?? 'unknown'}
    </span>
  );
}

function ScheduledTaskMetaPills({ scheduledTask }: { scheduledTask: ScheduledTask }) {
  const delivery = deliveryLabel(scheduledTask);
  return (
    <>
      <ScheduledTaskStatePill enabled={scheduledTask.enabled} />
      <Pill icon={<Clock3 size={13} />}>{scheduleSummary(scheduledTask)}</Pill>
      {shouldShowDeliveryPill(scheduledTask) && <Pill icon={<Send size={13} />}>{delivery}</Pill>}
    </>
  );
}

function deliveryLabel(scheduledTask: ScheduledTask): string {
  const deliver = scheduledTask.deliver?.trim();
  if (!deliver || deliver === 'local') return 'local';
  if (deliver === 'origin') return 'Original channel';
  return deliver;
}

function shouldShowDeliveryPill(scheduledTask: ScheduledTask): boolean {
  const deliver = scheduledTask.deliver?.trim();
  return Boolean(deliver && deliver !== 'origin');
}

function promptDescription(prompt: string | null): string {
  const line = prompt?.split('\n').find((item) => {
    const trimmed = item.trim();
    return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('-');
  })?.trim();
  return line ?? 'Self-contained runbook';
}

function findNewScheduledTaskRun(runs: ScheduledTaskRun[], poll: RunPollState): ScheduledTaskRun | null {
  if (!runs.length) return null;

  if (poll.previousLatestRunId) {
    return runs[0].id !== poll.previousLatestRunId ? runs[0] : null;
  }

  const cutoff = poll.startedAt - 5000;
  return runs.find((run) => {
    const ranAt = run.ranAt ? new Date(run.ranAt).getTime() : NaN;
    return Number.isFinite(ranAt) && ranAt >= cutoff;
  }) ?? null;
}

function initialFormState(scheduledTask?: ScheduledTask, template?: ScheduledTaskTemplate): ScheduledTaskFormState {
  const rawSchedule = scheduledTask ? scheduleRaw(scheduledTask) : template?.schedule ?? '0 9 * * 1-5';
  const schedule = detectPreset(rawSchedule);
  const deliver = scheduledTask?.deliver?.trim();
  const repeatTimes = scheduledTask?.repeat?.times ?? null;

  return {
    name: scheduledTask?.name ?? template?.name ?? '',
    prompt: scheduledTask?.prompt ?? template?.prompt ?? '',
    ...schedule,
    deliver: deliver || 'local',
    model: scheduledTask?.model ?? '',
    workdir: scheduledTask?.workdir ?? '',
    repeatMode: repeatTimes === 1 ? 'once' : repeatTimes ? 'times' : 'forever',
    repeatCount: repeatTimes && repeatTimes > 1 ? String(repeatTimes) : '3',
  };
}

function scheduledTaskInputFromForm(form: ScheduledTaskFormState, previous?: ScheduledTask): ScheduledTaskInput | Partial<ScheduledTaskInput> {
  const schedule = compileSchedule(form);
  const repeat = form.repeatMode === 'once'
    ? 1
    : form.repeatMode === 'times'
      ? Math.max(1, Number.parseInt(form.repeatCount, 10) || 1)
      : null;

  const input: ScheduledTaskInput = {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    schedule,
    deliver: form.deliver.trim() || 'local',
  };

  if (form.model.trim()) input.model = form.model.trim();
  else if (previous?.model) input.model = null;
  if (form.workdir.trim()) input.workdir = form.workdir.trim();
  else if (previous?.workdir) input.workdir = null;
  if (repeat !== null) input.repeat = repeat;
  else if (previous?.repeat?.times != null) input.repeat = null;

  if (!previous) return input;

  const updates: Partial<ScheduledTaskInput> = {};
  const previousSchedule = scheduleRaw(previous);
  const previousRepeat = previous.repeat?.times ?? null;
  if (input.name !== previous.name) updates.name = input.name;
  if (input.prompt !== (previous.prompt ?? '')) updates.prompt = input.prompt;
  if (input.schedule !== previousSchedule) updates.schedule = input.schedule;
  if (input.deliver !== (previous.deliver?.trim() || 'local')) updates.deliver = input.deliver;
  if ('model' in input) updates.model = input.model;
  if ('workdir' in input) updates.workdir = input.workdir;
  if (repeat !== previousRepeat) updates.repeat = repeat;
  return updates;
}

function sourcePathFromState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const from = (state as { from?: unknown }).from;
  return typeof from === 'string' && from.startsWith(ROUTES.list) ? from : null;
}

function PageShell({ children, fitted = false }: { children: ReactNode; fitted?: boolean }) {
  return (
    <div className={`flex-1 min-h-0 ${fitted ? 'overflow-y-auto lg:overflow-hidden' : 'overflow-y-auto'}`}>
      <div className={`mx-auto max-w-7xl px-3 py-3 sm:px-6 sm:py-5 ${fitted ? 'lg:h-full' : ''}`}>
        <div className={`overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 ${fitted ? 'lg:flex lg:h-full lg:min-h-0 lg:flex-col' : ''}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  children,
  variant = 'primary',
  disabled,
  onClick,
  type = 'button',
  form,
}: {
  icon?: ReactNode;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  form?: string;
}) {
  const cls = variant === 'primary'
    ? 'border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-white'
    : variant === 'danger'
      ? 'border-rose-200 bg-white text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:bg-zinc-950 dark:text-rose-300 dark:hover:bg-rose-950/30'
      : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800';
  return (
    <button
      type={type}
      form={form}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function IconButton({
  title,
  icon,
  disabled,
  danger,
  onClick,
}: {
  title: string;
  icon: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md border bg-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-950 ${
        danger
          ? 'border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/30'
          : 'border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
      }`}
    >
      {icon}
    </button>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-5 py-10 text-sm text-zinc-500 dark:text-zinc-400">
      <Loader2 size={15} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

function NotFoundPanel({ onBack }: { onBack: () => void }) {
  return (
    <div className="px-8 py-14 text-center">
      <Repeat size={34} strokeWidth={1.5} className="mx-auto mb-4 text-zinc-300 dark:text-zinc-700" />
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Scheduled task not found</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">It may have been removed from Hermes scheduled task storage.</p>
      <button
        type="button"
        onClick={onBack}
        className="mt-5 inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <ChevronLeft size={15} />
        <span>Back to scheduled tasks</span>
      </button>
    </div>
  );
}

function EmptyState({ onTemplate, onCreate }: { onTemplate: (template: ScheduledTaskTemplate) => void; onCreate: () => void }) {
  return (
    <div className="px-8 py-14 text-center">
      <Repeat size={40} strokeWidth={1.5} className="mx-auto mb-4 text-zinc-300 dark:text-zinc-700" />
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">No scheduled tasks yet</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Schedule recurring tasks for Hermes. Pick a template or start from scratch.
      </p>

      <div className="mx-auto mt-6 grid max-w-2xl grid-cols-1 gap-3 text-left md:grid-cols-2">
        {SCHEDULED_TASK_TEMPLATES.map((template) => {
          const Icon = template.icon;
          return (
            <button
              key={template.key}
              type="button"
              onClick={() => onTemplate(template)}
              className="rounded-lg border border-zinc-200 bg-white p-4 text-left transition hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
            >
              <div className="flex items-start gap-3">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                  <Icon size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{template.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{template.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onCreate}
        className="mt-6 inline-flex h-9 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3.5 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:hover:bg-zinc-800"
      >
        <Plus size={15} />
        <span>Start from scratch</span>
      </button>
    </div>
  );
}

function LoadingScheduledTasksView() {
  const headerConfig = useMemo<PageHeaderConfig>(() => ({ crumbs: [{ label: 'Scheduled Tasks' }] }), []);
  usePageHeader(headerConfig);
  return <LoadingPanel label="Loading scheduled tasks" />;
}

function ScheduledTaskNotFoundView({ onBack }: { onBack: () => void }) {
  const headerConfig = useMemo<PageHeaderConfig>(() => ({ crumbs: [{ label: 'Scheduled Tasks', to: ROUTES.list }, { label: 'Not found' }] }), []);
  usePageHeader(headerConfig);
  return <NotFoundPanel onBack={onBack} />;
}

function EmptyScheduledTasksView({
  onTemplate,
  onCreate,
}: {
  onTemplate: (template: ScheduledTaskTemplate) => void;
  onCreate: () => void;
}) {
  const headerActions = useMemo(() => (
    <ActionButton icon={<Plus size={15} />} onClick={onCreate}>New scheduled task</ActionButton>
  ), [onCreate]);
  const headerConfig = useMemo<PageHeaderConfig>(() => ({
    crumbs: [{ label: 'Scheduled Tasks' }],
    actions: headerActions,
  }), [headerActions]);

  usePageHeader(headerConfig);
  return <EmptyState onTemplate={onTemplate} onCreate={onCreate} />;
}

function ScheduledTasksList({
  scheduledTasks,
  pendingAction,
  onOpenRuns,
  onCreate,
  onEdit,
  onRun,
  onToggle,
  onDelete,
}: {
  scheduledTasks: ScheduledTask[];
  pendingAction: PendingAction | null;
  onOpenRuns: (scheduledTask: ScheduledTask) => void;
  onCreate: () => void;
  onEdit: (scheduledTask: ScheduledTask) => void;
  onRun: (scheduledTask: ScheduledTask) => void;
  onToggle: (scheduledTask: ScheduledTask) => void;
  onDelete: (scheduledTask: ScheduledTask) => void;
}) {
  const headerActions = useMemo(() => (
    <ActionButton icon={<Plus size={15} />} onClick={onCreate}>New scheduled task</ActionButton>
  ), [onCreate]);
  const headerConfig = useMemo<PageHeaderConfig>(() => ({
    crumbs: [{ label: 'Scheduled Tasks' }],
    actions: headerActions,
  }), [headerActions]);

  usePageHeader(headerConfig);

  return (
    <>
      <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 sm:px-5 dark:border-zinc-800">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Scheduled Tasks</h2>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{scheduledTasks.length} total</span>
      </div>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800 lg:hidden">
        {scheduledTasks.map((scheduledTask) => {
          const pending = pendingAction?.scheduledTaskId === scheduledTask.id;
          const description = promptDescription(scheduledTask.prompt);
          const schedule = scheduleSummary(scheduledTask);
          const lastRun = scheduledTask.lastRunAt ? relativeTime(scheduledTask.lastRunAt) : '-';
          const nextRun = scheduledTask.enabled ? relativeTime(scheduledTask.nextRunAt) : '-';

          return (
            <div
              key={scheduledTask.id}
              className={`px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${
                scheduledTask.enabled ? '' : 'opacity-75'
              }`}
            >
              <button
                type="button"
                onClick={() => onOpenRuns(scheduledTask)}
                className="-mx-1 block w-[calc(100%+0.5rem)] rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 dark:focus-visible:ring-zinc-700"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                    <FileText size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100" title={scheduledTask.name}>
                          {scheduledTask.name}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400" title={description}>
                          {description}
                        </p>
                      </div>
                      <ScheduledTaskStatePill enabled={scheduledTask.enabled} />
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                      {([
                        { label: 'Schedule', value: schedule, title: schedule, cls: 'text-zinc-700 dark:text-zinc-300' },
                        { label: 'Next', value: nextRun },
                        { label: 'Last', value: lastRun },
                        { label: 'Status', value: scheduledTask.lastStatus ?? 'unknown', cls: scheduledTaskStatusClass(scheduledTask.lastStatus) },
                      ] as { label: string; value: string; title?: string; cls?: string }[]).map((stat) => (
                        <div key={stat.label} className="min-w-0">
                          <p className="font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{stat.label}</p>
                          <p className={`mt-0.5 truncate ${stat.cls ?? 'text-zinc-500 dark:text-zinc-400'}`} title={stat.title}>{stat.value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </button>

              <div className="mt-3 flex items-center justify-end gap-1.5 pl-12">
                <IconButton title="Edit scheduled task" icon={<Pencil size={15} />} disabled={Boolean(pendingAction)} onClick={() => onEdit(scheduledTask)} />
                <IconButton title="Run now" icon={pending && pendingAction?.action === 'run' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} disabled={Boolean(pendingAction)} onClick={() => onRun(scheduledTask)} />
                <IconButton title={scheduledTask.enabled ? 'Pause' : 'Resume'} icon={pending && (pendingAction?.action === 'pause' || pendingAction?.action === 'resume') ? <Loader2 size={15} className="animate-spin" /> : scheduledTask.enabled ? <Pause size={15} /> : <Play size={15} />} disabled={Boolean(pendingAction)} onClick={() => onToggle(scheduledTask)} />
                <IconButton title="Delete" icon={<Trash2 size={15} />} danger disabled={Boolean(pendingAction)} onClick={() => onDelete(scheduledTask)} />
              </div>
              <span className="sr-only">Output destination: {deliveryLabel(scheduledTask)}</span>
            </div>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full min-w-[980px] table-fixed text-sm">
          <colgroup>
            <col className="w-[32%]" />
            <col className="w-[17%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[10%]" />
            <col className="w-[17%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs uppercase tracking-wide text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
              <th className="px-5 py-2.5 font-medium">Name</th>
              <th className="px-2 py-2.5 font-medium">Schedule</th>
              <th className="px-2 py-2.5 font-medium">Last run</th>
              <th className="px-2 py-2.5 font-medium">Next run</th>
              <th className="px-2 py-2.5 font-medium">Status</th>
              <th className="px-5 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {scheduledTasks.map((scheduledTask) => {
              const pending = pendingAction?.scheduledTaskId === scheduledTask.id;
              const description = promptDescription(scheduledTask.prompt);
              const schedule = scheduleSummary(scheduledTask);
              const lastRun = scheduledTask.lastRunAt ? relativeTime(scheduledTask.lastRunAt) : '-';
              const nextRun = scheduledTask.enabled ? relativeTime(scheduledTask.nextRunAt) : '-';
              return (
                <tr
                  key={scheduledTask.id}
                  onClick={() => onOpenRuns(scheduledTask)}
                  className={`cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${scheduledTask.enabled ? '' : 'opacity-75'}`}
                >
                  <td className="px-5 py-3 align-middle">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                        <FileText size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-zinc-900 dark:text-zinc-100" title={scheduledTask.name}>{scheduledTask.name}</p>
                        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400" title={description}>{description}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-3 align-middle text-zinc-700 dark:text-zinc-300">
                    <div className="truncate" title={schedule}>{schedule}</div>
                  </td>
                  <td className="px-2 py-3 align-middle text-zinc-500 dark:text-zinc-400">
                    <div className="truncate">
                      {lastRun}
                      {scheduledTask.lastStatus && (
                        <span className={`ml-1.5 inline-flex items-center gap-1 ${scheduledTaskStatusClass(scheduledTask.lastStatus)}`}>
                          · {scheduledTask.lastStatus}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-3 align-middle text-zinc-500 dark:text-zinc-400">
                    <div className="truncate">{nextRun}</div>
                  </td>
                  <td className="px-2 py-3 align-middle">
                    <ScheduledTaskStatePill enabled={scheduledTask.enabled} />
                  </td>
                  <td className="px-3 py-3 align-middle">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton title="Edit scheduled task" icon={<Pencil size={15} />} disabled={Boolean(pendingAction)} onClick={() => onEdit(scheduledTask)} />
                      <IconButton title="Run now" icon={pending && pendingAction?.action === 'run' ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} disabled={Boolean(pendingAction)} onClick={() => onRun(scheduledTask)} />
                      <IconButton title={scheduledTask.enabled ? 'Pause' : 'Resume'} icon={pending && (pendingAction?.action === 'pause' || pendingAction?.action === 'resume') ? <Loader2 size={15} className="animate-spin" /> : scheduledTask.enabled ? <Pause size={15} /> : <Play size={15} />} disabled={Boolean(pendingAction)} onClick={() => onToggle(scheduledTask)} />
                      <IconButton title="Delete" icon={<Trash2 size={15} />} danger disabled={Boolean(pendingAction)} onClick={() => onDelete(scheduledTask)} />
                    </div>
                    <span className="sr-only">Output destination: {deliveryLabel(scheduledTask)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {scheduledTasks.length === 0 && (
        <div className="px-5 py-12 text-center text-sm text-zinc-400 dark:text-zinc-500">
          No scheduled tasks match this view.
        </div>
      )}
    </>
  );
}

function FieldLabel({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block text-xs font-medium text-zinc-500 dark:text-zinc-400 ${className ?? ''}`}>
      {label}
      {children}
    </label>
  );
}

const INPUT_CLASS = 'mt-1 h-9 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-base text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  autoFocus,
  type = 'text',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
  type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className={`${INPUT_CLASS} ${mono ? 'font-mono' : ''}`}
    />
  );
}

function SelectInput({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={INPUT_CLASS}>
      {children}
    </select>
  );
}

function ScheduledTaskEditorPage({
  mode,
  scheduledTask,
  template,
  saving,
  justSaved = false,
  error,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  scheduledTask?: ScheduledTask;
  template?: ScheduledTaskTemplate;
  saving: boolean;
  justSaved?: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (form: ScheduledTaskFormState) => void;
}) {
  const [form, setForm] = useState<ScheduledTaskFormState>(() => initialFormState(scheduledTask, template));
  const { defaults: agentDefaults, modelGroups } = useAgentConfig();
  const schedule = useMemo(
    () => compileSchedule(form),
    [form.preset, form.time, form.weekday, form.intervalValue, form.intervalUnit, form.rawSchedule],
  );
  const preview = useMemo(
    () => nextRunPreview(form, schedule),
    [schedule, form.preset, form.intervalValue, form.intervalUnit],
  );
  const isEdit = mode === 'edit';
  const canSubmit = form.name.trim().length > 0 && form.prompt.trim().length > 0 && schedule.trim().length > 0 && !preview.invalid && !saving;

  function patch(updates: Partial<ScheduledTaskFormState>) {
    setForm((current) => ({ ...current, ...updates }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(form);
  }

  const headerActions = useMemo(() => {
    const indicatorVisible = saving || justSaved;
    return (
      <>
        <span
          aria-live="polite"
          aria-hidden={!indicatorVisible}
          className={`shrink-0 text-xs text-zinc-400 transition-opacity duration-300 dark:text-zinc-500 ${
            indicatorVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {saving ? 'Saving…' : 'Saved'}
        </span>
        <ActionButton variant="secondary" onClick={onCancel}>Cancel</ActionButton>
        <ActionButton
          type="submit"
          form={SCHEDULED_TASK_EDITOR_FORM_ID}
          disabled={!canSubmit}
          icon={saving ? <Loader2 size={14} className="animate-spin" /> : undefined}
        >
          {isEdit ? 'Update' : 'Create'}
        </ActionButton>
      </>
    );
  }, [canSubmit, isEdit, justSaved, onCancel, saving]);
  const headerConfig = useMemo<PageHeaderConfig>(() => ({
    crumbs: [
      { label: 'Scheduled Tasks', to: ROUTES.list },
      ...(isEdit && scheduledTask ? [{ label: scheduledTask.name, to: ROUTES.runs(scheduledTask.id) }] : []),
      { label: isEdit ? 'Edit' : 'New scheduled task' },
    ],
    actions: headerActions,
  }), [headerActions, isEdit, scheduledTask]);

  usePageHeader(headerConfig);

  return (
    <form id={SCHEDULED_TASK_EDITOR_FORM_ID} onSubmit={submit}>
      {error && (
        <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-5 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
          <AlertCircle size={15} />
          <span className="truncate">{error}</span>
        </div>
      )}

      <div className="grid min-h-[640px] grid-cols-1 lg:h-[calc(100vh-9.5rem)] lg:min-h-[560px] lg:grid-cols-[minmax(0,1fr)_360px] lg:overflow-hidden">
        <div className="flex min-w-0 flex-col gap-4 border-b border-zinc-200 p-5 lg:min-h-0 lg:border-b-0 lg:border-r dark:border-zinc-800">
          <FieldLabel label="Name">
            <TextInput
              value={form.name}
              onChange={(name) => patch({ name })}
              placeholder="Weekly digest"
              autoFocus={!isEdit}
            />
          </FieldLabel>

          <label className="flex min-h-0 flex-1 flex-col text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Instructions
            <textarea
              value={form.prompt}
              onChange={(event) => patch({ prompt: event.target.value })}
              autoFocus={isEdit}
              rows={24}
              placeholder="# Goal&#10;Describe exactly what Hermes should do on every run."
              className="mt-1 min-h-[480px] w-full flex-1 resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2.5 font-mono text-base leading-6 text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none lg:min-h-0 lg:resize-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </label>
        </div>

        <aside className="space-y-5 p-5 lg:min-h-0 lg:overflow-y-auto">
          <section>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Schedule</h3>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <FieldLabel label="Preset" className="col-span-2">
                <SelectInput value={form.preset} onChange={(v) => patch({ preset: v as SchedulePreset })}>
                  <option value="weekdays">Weekdays</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="interval">Every interval</option>
                  <option value="custom">Custom</option>
                </SelectInput>
              </FieldLabel>

              {(form.preset === 'weekdays' || form.preset === 'daily' || form.preset === 'weekly') && (
                <FieldLabel label="At">
                  <TextInput type="time" value={form.time} onChange={(time) => patch({ time })} />
                </FieldLabel>
              )}

              {form.preset === 'weekly' && (
                <FieldLabel label="Day">
                  <SelectInput value={form.weekday} onChange={(weekday) => patch({ weekday })}>
                    {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                  </SelectInput>
                </FieldLabel>
              )}

              {form.preset === 'interval' && (
                <>
                  <FieldLabel label="Every">
                    <TextInput type="number" value={form.intervalValue} onChange={(intervalValue) => patch({ intervalValue })} />
                  </FieldLabel>
                  <FieldLabel label="Unit">
                    <SelectInput value={form.intervalUnit} onChange={(v) => patch({ intervalUnit: v as IntervalUnit })}>
                      <option value="m">Minutes</option>
                      <option value="h">Hours</option>
                      <option value="d">Days</option>
                    </SelectInput>
                  </FieldLabel>
                </>
              )}

              {form.preset === 'custom' && (
                <FieldLabel label="Cron expression" className="col-span-2">
                  <TextInput
                    mono
                    value={form.rawSchedule}
                    onChange={(rawSchedule) => patch({ rawSchedule })}
                    placeholder="0 9 * * 1-5"
                  />
                </FieldLabel>
              )}
            </div>
            <div className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
              {preview.invalid ? (
                <span className="text-rose-600 dark:text-rose-400">Invalid schedule</span>
              ) : preview.uncertain ? (
                <span>Hermes will validate this schedule when you save.</span>
              ) : (
                <span>Next run: {preview.date ? formatDate(preview.date.toISOString()) : '-'}</span>
              )}
            </div>
          </section>

          <section className="border-t border-zinc-200 pt-5 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Output</h3>
            <div className="mt-3">
              <FieldLabel label="Delivery target">
                <TextInput
                  mono
                  value={form.deliver}
                  onChange={(deliver) => patch({ deliver })}
                  placeholder="local, origin, slack:#eng, telegram:123, discord:#eng"
                />
              </FieldLabel>
              <a href={HERMES_DELIVERY_DOCS} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
                Delivery targets
                <ExternalLink size={12} />
              </a>
            </div>
          </section>

          <section className="border-t border-zinc-200 pt-5 dark:border-zinc-800">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Model</h3>
            <div className="mt-3">
              <ModelPicker
                value={form.model}
                defaultModel={agentDefaults?.model ?? null}
                modelGroups={modelGroups}
                title="Scheduled task model"
                onChange={(model) => patch({ model })}
              />
            </div>
          </section>

          <details className="border-t border-zinc-200 pt-5 dark:border-zinc-800">
            <summary className="cursor-pointer list-none text-sm font-semibold text-zinc-900 outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 dark:text-zinc-100 dark:focus-visible:ring-zinc-700">
              Advanced
            </summary>
            <div className="mt-3 space-y-3">
              <FieldLabel label="Workdir">
                <TextInput mono value={form.workdir} onChange={(workdir) => patch({ workdir })} placeholder="~/.minions/workspace" />
              </FieldLabel>
              <FieldLabel label="Repeat">
                <SelectInput value={form.repeatMode} onChange={(v) => patch({ repeatMode: v as RepeatMode })}>
                  <option value="forever">Forever</option>
                  <option value="once">Only once</option>
                  <option value="times">N times</option>
                </SelectInput>
              </FieldLabel>
              {form.repeatMode === 'times' && (
                <FieldLabel label="Runs">
                  <TextInput type="number" value={form.repeatCount} onChange={(repeatCount) => patch({ repeatCount })} />
                </FieldLabel>
              )}
            </div>
          </details>
        </aside>
      </div>
    </form>
  );
}

function ScheduledTaskRunsView({
  scheduledTask,
  runs,
  activeRunId,
  runContent,
  runFilter,
  loadingRuns,
  loadingContent,
  pendingAction,
  waitingForRun,
  onRunFilterChange,
  onEdit,
  onRun,
  onSelectRun,
}: {
  scheduledTask: ScheduledTask;
  runs: ScheduledTaskRun[];
  activeRunId: string | null;
  runContent: ScheduledTaskRunContent | null;
  runFilter: RunFilterMode;
  loadingRuns: boolean;
  loadingContent: boolean;
  pendingAction: PendingAction | null;
  waitingForRun: boolean;
  onRunFilterChange: (filter: RunFilterMode) => void;
  onEdit: () => void;
  onRun: () => void;
  onSelectRun: (runId: string) => void;
}) {
  const visibleRuns = runFilter === 'errors' ? runs.filter((run) => run.status === 'error') : runs;
  const runCountLabel = runs.length >= RUNS_PAGE_SIZE ? `latest ${RUNS_PAGE_SIZE}` : `${runs.length} total`;
  const isRunning = pendingAction?.action === 'run' && pendingAction.scheduledTaskId === scheduledTask.id;
  const activeRun = useMemo(() => runs.find((run) => run.id === activeRunId) ?? null, [activeRunId, runs]);
  const activeRunStatus = activeRun?.status ?? runContent?.status ?? null;
  const runBody = runContent?.body.trim() ?? '';
  const headerActions = useMemo(() => (
    <>
      <div className="hidden items-center gap-2 lg:flex">
        <ScheduledTaskMetaPills scheduledTask={scheduledTask} />
      </div>
      <ActionButton variant="secondary" icon={<Pencil size={14} />} onClick={onEdit}>Edit</ActionButton>
      <ActionButton icon={isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} disabled={Boolean(pendingAction)} onClick={onRun}>Run now</ActionButton>
    </>
  ), [isRunning, onEdit, onRun, pendingAction, scheduledTask]);
  const headerConfig = useMemo<PageHeaderConfig>(() => ({
    crumbs: [
      { label: 'Scheduled Tasks', to: ROUTES.list },
      { label: scheduledTask.name },
    ],
    actions: headerActions,
  }), [headerActions, scheduledTask.name]);

  usePageHeader(headerConfig);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-5 py-2 lg:hidden dark:border-zinc-800 dark:bg-zinc-900/60">
        <ScheduledTaskMetaPills scheduledTask={scheduledTask} />
      </div>

      <div className="grid min-h-[640px] grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[340px_minmax(0,1fr)] lg:overflow-hidden">
        <aside className="border-b border-zinc-200 bg-white lg:flex lg:min-h-0 lg:flex-col lg:border-b-0 lg:border-r dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Runs <span className="font-normal text-zinc-400 dark:text-zinc-500">{runCountLabel}</span></h3>
              {waitingForRun && (
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                  <Loader2 size={12} className="animate-spin" />
                  Waiting for output
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <div className="inline-flex h-7 overflow-hidden rounded-md border border-zinc-200 text-xs dark:border-zinc-700">
                {(['all', 'errors'] as RunFilterMode[]).map((filter, index) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => onRunFilterChange(filter)}
                    className={`px-2 capitalize ${index ? 'border-l border-zinc-200 dark:border-zinc-700' : ''} ${
                      runFilter === filter
                        ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                        : 'text-zinc-500 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="min-h-0 lg:flex-1 lg:overflow-y-auto">
            {loadingRuns && runs.length === 0 ? (
              <LoadingPanel label="Loading runs" />
            ) : visibleRuns.length === 0 ? (
              <div className="px-4 py-8 text-sm text-zinc-400 dark:text-zinc-500">
                {runFilter === 'errors' ? 'No error runs.' : 'No output files yet.'}
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {visibleRuns.map((run) => {
                  const selected = run.id === activeRunId;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => onSelectRun(run.id)}
                      className={`block w-full px-4 py-3 text-left transition-colors ${
                        selected ? 'bg-zinc-100 dark:bg-zinc-900' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/70'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{formatDate(run.ranAt)}</p>
                          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{relativeTime(run.ranAt)}</p>
                        </div>
                        <RunStatusPill status={run.status} />
                      </div>
                      {run.preview && <p className="mt-2 line-clamp-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{run.preview}</p>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="min-w-0 bg-zinc-50 lg:min-h-0 lg:overflow-y-auto dark:bg-zinc-900/60">
          <div className="p-4">
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
                <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {activeRunStatus === 'error' ? 'Error' : 'Response'}
                </h4>
                <button
                  type="button"
                  onClick={onEdit}
                  className="inline-flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  <Pencil size={11} />
                  Edit prompt
                </button>
              </div>
              <div className="min-h-[360px] p-4">
                {loadingContent ? (
                  <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                    <Loader2 size={14} className="animate-spin" />
                    <span>Loading output</span>
                  </div>
                ) : runBody ? (
                  <MarkdownContent content={runBody} />
                ) : (
                  <p className="text-sm text-zinc-400 dark:text-zinc-500">
                    {activeRunId ? 'No content available for this run.' : 'Select a run to view its output.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

export function ScheduledTasksPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { scheduledTaskId, runId } = useParams<{ scheduledTaskId?: string; runId?: string }>();
  const selectedScheduledTaskId = scheduledTaskId ?? null;

  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [runContent, setRunContent] = useState<ScheduledTaskRunContent | null>(null);
  const [loadingScheduledTasks, setLoadingScheduledTasks] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [runFilter, setRunFilter] = useState<RunFilterMode>('all');
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [justSaved]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const [templateDraft, setTemplateDraft] = useState<ScheduledTaskTemplate | undefined>(undefined);
  const [runPoll, setRunPoll] = useState<RunPollState | null>(null);

  const runsRef = useRef<ScheduledTaskRun[]>([]);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  const isCreateRoute = location.pathname === ROUTES.new;
  const isEditRoute = Boolean(selectedScheduledTaskId && location.pathname.endsWith('/edit'));
  const isRunsRoute = Boolean(selectedScheduledTaskId && !isCreateRoute && !isEditRoute);
  const selectedScheduledTask = selectedScheduledTaskId ? scheduledTasks.find((scheduledTask) => scheduledTask.id === selectedScheduledTaskId) ?? null : null;
  const selectedRunId = runId ?? null;
  const activeRunId = selectedRunId ?? runs[0]?.id ?? null;
  const waitingForRun = Boolean(runPoll && runPoll.scheduledTaskId === selectedScheduledTaskId);

  const replaceScheduledTask = useCallback((scheduledTask: ScheduledTask) => {
    setScheduledTasks((current) => (
      current.some((item) => item.id === scheduledTask.id)
        ? current.map((item) => (item.id === scheduledTask.id ? scheduledTask : item))
        : [scheduledTask, ...current]
    ));
  }, []);

  const loadScheduledTasks = useCallback(async () => {
    setLoadingScheduledTasks(true);
    try {
      const { scheduledTasks: nextScheduledTasks } = await fetchScheduledTasks(true);
      setScheduledTasks(nextScheduledTasks);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to load scheduled tasks'));
    } finally {
      setLoadingScheduledTasks(false);
    }
  }, []);

  const refreshRuns = useCallback(async (scheduledTaskId: string) => {
    setLoadingRuns(true);
    try {
      const { runs: nextRuns } = await fetchScheduledTaskRuns(scheduledTaskId, RUNS_PAGE_SIZE);
      setRuns(nextRuns);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to load scheduled task runs'));
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    loadScheduledTasks();
  }, [loadScheduledTasks]);

  useEffect(() => {
    if (!selectedScheduledTaskId || selectedScheduledTask || loadingScheduledTasks) return;
    let cancelled = false;
    fetchScheduledTask(selectedScheduledTaskId)
      .then(({ scheduledTask }) => {
        if (cancelled) return;
        if (scheduledTask) replaceScheduledTask(scheduledTask);
        else navigate(ROUTES.list, { replace: true });
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err, 'Failed to load scheduled task'));
      });
    return () => { cancelled = true; };
  }, [loadingScheduledTasks, navigate, replaceScheduledTask, selectedScheduledTask, selectedScheduledTaskId]);

  useEffect(() => {
    if (!selectedScheduledTaskId || !isRunsRoute) {
      setRuns([]);
      setRunContent(null);
      return;
    }
    refreshRuns(selectedScheduledTaskId).catch(() => {});
  }, [isRunsRoute, refreshRuns, selectedScheduledTaskId]);

  useEffect(() => {
    if (selectedScheduledTaskId && isRunsRoute && !location.pathname.includes('/runs')) {
      navigate(ROUTES.runs(selectedScheduledTaskId), { replace: true });
    }
  }, [isRunsRoute, location.pathname, navigate, selectedScheduledTaskId]);

  useEffect(() => {
    if (!runPoll) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - runPoll.startedAt > RUN_POLL_TIMEOUT_MS) {
        setRunPoll(null);
        return;
      }

      try {
        const { runs: latest } = await fetchScheduledTaskRuns(runPoll.scheduledTaskId, RUNS_PAGE_SIZE);
        if (cancelled) return;
        const newRun = findNewScheduledTaskRun(latest, runPoll);
        if (newRun) {
          if (selectedScheduledTaskId === runPoll.scheduledTaskId) {
            setRuns(latest);
            navigate(ROUTES.run(runPoll.scheduledTaskId, newRun.id));
          }
          fetchScheduledTask(runPoll.scheduledTaskId)
            .then(({ scheduledTask }) => { if (scheduledTask) replaceScheduledTask(scheduledTask); })
            .catch(() => {});
          setRunPoll(null);
          return;
        }
      } catch {
        // transient failure; keep polling until timeout
      }

      if (!cancelled) timer = setTimeout(tick, RUN_POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, RUN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [navigate, replaceScheduledTask, runPoll, selectedScheduledTaskId]);

  useEffect(() => {
    if (!isRunsRoute || !selectedScheduledTaskId || !activeRunId) {
      setRunContent(null);
      return;
    }

    let cancelled = false;
    setRunContent(null);
    setLoadingContent(true);
    fetchScheduledTaskRunContent(selectedScheduledTaskId, activeRunId)
      .then(({ content }) => {
        if (!cancelled) setRunContent(content);
      })
      .catch(() => {
        if (!cancelled) setRunContent(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });

    return () => { cancelled = true; };
  }, [activeRunId, isRunsRoute, selectedScheduledTaskId]);

  const currentScheduledTaskPath = useCallback(() => `${location.pathname}${location.search}`, [location.pathname, location.search]);

  const openCreate = useCallback((template?: ScheduledTaskTemplate) => {
    setTemplateDraft(template);
    setEditorError(null);
    navigate(ROUTES.new, { state: { from: currentScheduledTaskPath() } });
  }, [currentScheduledTaskPath, navigate]);

  const openEdit = useCallback((scheduledTask: ScheduledTask) => {
    setEditorError(null);
    navigate(ROUTES.edit(scheduledTask.id), { state: { from: currentScheduledTaskPath() } });
  }, [currentScheduledTaskPath, navigate]);

  const runScheduledTaskAction = useCallback(async (
    action: 'pause' | 'resume' | 'run',
    scheduledTask: ScheduledTask,
  ) => {
    setPendingAction({ action, scheduledTaskId: scheduledTask.id });
    const previousLatestRunId = selectedScheduledTaskId === scheduledTask.id ? runsRef.current[0]?.id ?? null : null;

    try {
      let result: { scheduledTask: ScheduledTask };
      if (action === 'pause') result = await pauseScheduledTask(scheduledTask.id, DEFAULT_PAUSE_REASON);
      else if (action === 'resume') result = await resumeScheduledTask(scheduledTask.id);
      else result = await runScheduledTask(scheduledTask.id);
      replaceScheduledTask(result.scheduledTask);
      setError(null);
      if (action === 'run') {
        setRunPoll({
          scheduledTaskId: scheduledTask.id,
          previousLatestRunId,
          startedAt: Date.now(),
        });
      }
    } catch (err) {
      setError(toErrorMessage(err, `Failed to ${action} scheduled task`));
    } finally {
      setPendingAction(null);
    }
  }, [replaceScheduledTask, selectedScheduledTaskId]);

  const submitEditor = useCallback(async (form: ScheduledTaskFormState) => {
    setSaving(true);
    setEditorError(null);
    try {
      if (isCreateRoute) {
        const input = scheduledTaskInputFromForm(form) as ScheduledTaskInput;
        const { scheduledTask } = await createScheduledTask(input);
        replaceScheduledTask(scheduledTask);
        setTemplateDraft(undefined);
        navigate(ROUTES.runs(scheduledTask.id));
      } else if (selectedScheduledTask) {
        const updates = scheduledTaskInputFromForm(form, selectedScheduledTask) as Partial<ScheduledTaskInput>;
        if (Object.keys(updates).length > 0) {
          const { scheduledTask } = await updateScheduledTask(selectedScheduledTask.id, updates);
          replaceScheduledTask(scheduledTask);
        }
        setJustSaved(true);
      }
    } catch (err) {
      setEditorError(toErrorMessage(err, isCreateRoute ? 'Failed to create scheduled task' : 'Failed to update scheduled task'));
    } finally {
      setSaving(false);
    }
  }, [isCreateRoute, navigate, replaceScheduledTask, selectedScheduledTask]);

  const cancelEditor = useCallback(() => {
    const from = sourcePathFromState(location.state);
    setTemplateDraft(undefined);
    if (from) navigate(from);
    else if (selectedScheduledTaskId) navigate(ROUTES.runs(selectedScheduledTaskId));
    else navigate(ROUTES.list);
  }, [location.state, navigate, selectedScheduledTaskId]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const scheduledTaskId = deleteTarget.id;
    setPendingAction({ action: 'delete', scheduledTaskId });
    try {
      await deleteScheduledTask(scheduledTaskId);
      setScheduledTasks((current) => current.filter((scheduledTask) => scheduledTask.id !== scheduledTaskId));
      if (selectedScheduledTaskId === scheduledTaskId) {
        navigate(ROUTES.list, { replace: true });
        setRuns([]);
        setRunContent(null);
      }
      setDeleteTarget(null);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to delete scheduled task'));
    } finally {
      setPendingAction(null);
    }
  }, [deleteTarget, navigate, selectedScheduledTaskId]);

  const goToScheduledTasks = useCallback(() => navigate(ROUTES.list), [navigate]);
  const openBlankScheduledTask = useCallback(() => openCreate(), [openCreate]);
  const editSelectedScheduledTask = useCallback(() => {
    if (selectedScheduledTask) openEdit(selectedScheduledTask);
  }, [openEdit, selectedScheduledTask]);
  const runSelectedScheduledTask = useCallback(() => {
    if (selectedScheduledTask) runScheduledTaskAction('run', selectedScheduledTask).catch(() => {});
  }, [runScheduledTaskAction, selectedScheduledTask]);
  const selectScheduledTaskRun = useCallback((nextRunId: string) => {
    if (selectedScheduledTask) navigate(ROUTES.run(selectedScheduledTask.id, nextRunId));
  }, [navigate, selectedScheduledTask]);
  const openScheduledTaskRuns = useCallback((scheduledTask: ScheduledTask) => {
    navigate(ROUTES.runs(scheduledTask.id));
  }, [navigate]);
  const runScheduledTaskFromList = useCallback((scheduledTask: ScheduledTask) => {
    navigate(ROUTES.runs(scheduledTask.id));
    runScheduledTaskAction('run', scheduledTask).catch(() => {});
  }, [navigate, runScheduledTaskAction]);
  const toggleScheduledTask = useCallback((scheduledTask: ScheduledTask) => {
    runScheduledTaskAction(scheduledTask.enabled ? 'pause' : 'resume', scheduledTask).catch(() => {});
  }, [runScheduledTaskAction]);
  const requestDeleteScheduledTask = useCallback((scheduledTask: ScheduledTask) => {
    setDeleteTarget(scheduledTask);
  }, []);

  function renderBody() {
    if (isCreateRoute) {
      return (
        <ScheduledTaskEditorPage
          key={`create:${templateDraft?.key ?? 'blank'}`}
          mode="create"
          template={templateDraft}
          saving={saving}
          error={editorError}
          onCancel={cancelEditor}
          onSubmit={submitEditor}
        />
      );
    }

    if (loadingScheduledTasks && scheduledTasks.length === 0) {
      return <LoadingScheduledTasksView />;
    }

    if (isEditRoute) {
      if (!selectedScheduledTask) return <ScheduledTaskNotFoundView onBack={goToScheduledTasks} />;
      return (
        <ScheduledTaskEditorPage
          key={`edit:${selectedScheduledTask.id}`}
          mode="edit"
          scheduledTask={selectedScheduledTask}
          saving={saving}
          justSaved={justSaved}
          error={editorError}
          onCancel={cancelEditor}
          onSubmit={submitEditor}
        />
      );
    }

    if (isRunsRoute) {
      if (!selectedScheduledTask) return <ScheduledTaskNotFoundView onBack={goToScheduledTasks} />;
      return (
        <ScheduledTaskRunsView
          scheduledTask={selectedScheduledTask}
          runs={runs}
          activeRunId={activeRunId}
          runContent={runContent}
          runFilter={runFilter}
          loadingRuns={loadingRuns}
          loadingContent={loadingContent}
          pendingAction={pendingAction}
          waitingForRun={waitingForRun}
          onRunFilterChange={setRunFilter}
          onEdit={editSelectedScheduledTask}
          onRun={runSelectedScheduledTask}
          onSelectRun={selectScheduledTaskRun}
        />
      );
    }

    if (scheduledTasks.length === 0) {
      return <EmptyScheduledTasksView onTemplate={openCreate} onCreate={openBlankScheduledTask} />;
    }

    return (
      <ScheduledTasksList
        scheduledTasks={scheduledTasks}
        pendingAction={pendingAction}
        onOpenRuns={openScheduledTaskRuns}
        onCreate={openBlankScheduledTask}
        onEdit={openEdit}
        onRun={runScheduledTaskFromList}
        onToggle={toggleScheduledTask}
        onDelete={requestDeleteScheduledTask}
      />
    );
  }

  return (
    <>
      <PageShell fitted={isRunsRoute}>
        {error && !isEditRoute && !isCreateRoute && (
          <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-5 py-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
            <AlertCircle size={15} />
            <span className="truncate">{error}</span>
          </div>
        )}
        {renderBody()}
      </PageShell>

      {deleteTarget && (
        <DeleteConfirmModal
          title="Delete scheduled task?"
          body={`Delete "${deleteTarget.name}" from Hermes scheduled task storage.`}
          isConfirming={pendingAction?.action === 'delete' && pendingAction.scheduledTaskId === deleteTarget.id}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Link2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  deleteCronJob,
  fetchCronJobs,
  fetchCronRunContent,
  fetchCronRuns,
  pauseCronJob,
  resumeCronJob,
  runCronJob,
} from '../lib/api';
import { formatDate, toErrorMessage } from '../lib/format';
import { useStore } from '../lib/store';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { MarkdownContent } from './MarkdownContent';
import type { CronJob, CronRun } from '@shared/types';

const DEFAULT_PAUSE_REASON = 'Paused from Minions';

interface PendingAction {
  action: 'pause' | 'resume' | 'run' | 'delete';
  jobId: string;
}

function statusClass(status: string | null | undefined): string {
  if (status === 'ok') return 'text-zinc-700 dark:text-zinc-300';
  if (status === 'error') return 'text-red-600 dark:text-red-400';
  return 'text-zinc-500 dark:text-zinc-400';
}

function CronStatusIcon({ status }: { status: string | null | undefined }) {
  if (status === 'ok') return <CheckCircle2 size={14} />;
  if (status === 'error') return <XCircle size={14} />;
  return <Clock3 size={14} />;
}

function JobActionButton({
  icon,
  label,
  loading,
  disabled,
  title,
  variant = 'default',
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  loading: boolean;
  disabled: boolean;
  title: string;
  variant?: 'default' | 'danger';
  onClick: () => void;
}) {
  const cls = variant === 'danger'
    ? 'border-red-200 dark:border-red-900 text-red-600 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/30'
    : 'border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${cls}`}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      <span>{label}</span>
    </button>
  );
}

function scheduleSummary(job: CronJob): string {
  if (job.scheduleDisplay) return job.scheduleDisplay;
  const kind = typeof job.schedule?.kind === 'string' ? job.schedule.kind : null;
  return kind ?? 'Unscheduled';
}

export function CronPage() {
  const tasks = useStore((s) => s.tasks);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [runContent, setRunContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null;

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const { jobs: nextJobs } = await fetchCronJobs(true);
      setJobs(nextJobs);
      setSelectedJobId((current) => (
        current && nextJobs.some((job) => job.id === current)
          ? current
          : nextJobs[0]?.id ?? null
      ));
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to load cron jobs'));
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  const replaceJob = useCallback((job: CronJob) => {
    setJobs((current) => {
      if (current.some((item) => item.id === job.id)) {
        return current.map((item) => (item.id === job.id ? job : item));
      }
      return [job, ...current];
    });
  }, []);

  const runJobAction = useCallback(async (
    action: 'pause' | 'resume' | 'run',
    job: CronJob,
  ) => {
    setPendingAction({ action, jobId: job.id });
    try {
      let result: { job: CronJob };
      if (action === 'pause') result = await pauseCronJob(job.id, DEFAULT_PAUSE_REASON);
      else if (action === 'resume') result = await resumeCronJob(job.id);
      else result = await runCronJob(job.id);
      replaceJob(result.job);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err, `Failed to ${action} cron job`));
    } finally {
      setPendingAction(null);
    }
  }, [replaceJob]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    const jobId = deleteTarget.id;
    setPendingAction({ action: 'delete', jobId });
    try {
      await deleteCronJob(jobId);
      setJobs((prev) => prev.filter((job) => job.id !== jobId));
      setSelectedJobId((current) => current === jobId ? null : current);
      setRuns([]);
      setSelectedRunId(null);
      setRunContent(null);
      setDeleteTarget(null);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to delete cron job'));
    } finally {
      setPendingAction(null);
    }
  }, [deleteTarget]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!selectedJobId) {
      setRuns([]);
      setSelectedRunId(null);
      setRunContent(null);
      return;
    }

    let cancelled = false;
    setLoadingRuns(true);
    fetchCronRuns(selectedJobId, 20)
      .then(({ runs: nextRuns }) => {
        if (cancelled) return;
        setRuns(nextRuns);
        setSelectedRunId(nextRuns[0]?.id ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err, 'Failed to load cron runs'));
      })
      .finally(() => {
        if (!cancelled) setLoadingRuns(false);
      });

    return () => { cancelled = true; };
  }, [selectedJobId]);

  useEffect(() => {
    if (!selectedJobId || !selectedRunId) {
      setRunContent(null);
      return;
    }

    let cancelled = false;
    setLoadingContent(true);
    fetchCronRunContent(selectedJobId, selectedRunId)
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
  }, [selectedJobId, selectedRunId]);

  const linkedTaskLabels = selectedJob?.linkedTaskIds
    ?.map((id) => taskById.get(id)?.title ?? id)
    .filter(Boolean) ?? [];
  const isSelectedAction = (action: PendingAction['action']) => (
    selectedJob ? pendingAction?.action === action && pendingAction.jobId === selectedJob.id : false
  );

  return (
    <>
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <CalendarClock size={20} className="text-zinc-500 dark:text-zinc-400 shrink-0" />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Scheduled Jobs</h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                Hermes cron jobs and saved run output
              </p>
            </div>
          </div>
          <button
            onClick={loadJobs}
            disabled={loadingJobs}
            title="Refresh cron jobs"
            className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
          >
            {loadingJobs ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            <AlertCircle size={15} />
            <span className="truncate">{error}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4 min-h-[620px]">
          <div className="border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              Jobs
            </div>
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-[680px] overflow-y-auto">
              {loadingJobs && jobs.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500 dark:text-zinc-400">
                  <Loader2 size={14} className="animate-spin" />
                  Loading jobs
                </div>
              )}
              {!loadingJobs && jobs.length === 0 && (
                <div className="px-3 py-10 text-center text-sm text-zinc-400 dark:text-zinc-500">
                  No Hermes cron jobs found.
                </div>
              )}
              {jobs.map((job) => (
                <button
                  key={job.id}
                  onClick={() => setSelectedJobId(job.id)}
                  className={`w-full text-left px-3 py-3 transition-colors ${
                    selectedJobId === job.id
                      ? 'bg-zinc-100 dark:bg-zinc-800'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {job.name}
                      </p>
                      <p className="mt-0.5 text-xs font-mono text-zinc-400 dark:text-zinc-500 truncate">
                        {job.id}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-xs shrink-0 ${statusClass(job.lastStatus)}`}>
                      <CronStatusIcon status={job.lastStatus} />
                      {job.lastStatus ?? job.state ?? 'idle'}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="truncate">{scheduleSummary(job)}</span>
                    <span className={job.enabled ? 'text-zinc-700 dark:text-zinc-300' : 'text-zinc-400 dark:text-zinc-500'}>
                      {job.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-0 border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 rounded-lg overflow-hidden">
            {!selectedJob ? (
              <div className="h-full flex items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
                Select a cron job.
              </div>
            ) : (
              <div className="h-full flex flex-col min-h-0">
                <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                        {selectedJob.name}
                      </h2>
                      <p className="mt-0.5 text-xs font-mono text-zinc-400 dark:text-zinc-500 truncate">
                        {selectedJob.id}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-1.5 text-xs shrink-0 ${statusClass(selectedJob.lastStatus)}`}>
                      <CronStatusIcon status={selectedJob.lastStatus} />
                      {selectedJob.lastStatus ?? selectedJob.state ?? 'idle'}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">Schedule</p>
                      <p className="mt-0.5 text-zinc-700 dark:text-zinc-300 truncate">{scheduleSummary(selectedJob)}</p>
                    </div>
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">Next</p>
                      <p className="mt-0.5 text-zinc-700 dark:text-zinc-300 truncate">{formatDate(selectedJob.nextRunAt)}</p>
                    </div>
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">Last</p>
                      <p className="mt-0.5 text-zinc-700 dark:text-zinc-300 truncate">{formatDate(selectedJob.lastRunAt)}</p>
                    </div>
                    <div>
                      <p className="text-zinc-400 dark:text-zinc-500">Model</p>
                      <p className="mt-0.5 text-zinc-700 dark:text-zinc-300 truncate">{selectedJob.model ?? selectedJob.provider ?? 'Default'}</p>
                    </div>
                  </div>

                  {linkedTaskLabels.length > 0 && (
                    <div className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 min-w-0">
                      <Link2 size={13} className="shrink-0" />
                      <span className="truncate">{linkedTaskLabels.join(', ')}</span>
                    </div>
                  )}

                  {selectedJob.lastError && (
                    <p className="mt-3 text-xs text-red-600 dark:text-red-400 truncate">
                      {selectedJob.lastError}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <JobActionButton
                      icon={selectedJob.enabled ? <Pause size={14} /> : <Play size={14} />}
                      label={selectedJob.enabled ? 'Pause' : 'Resume'}
                      loading={isSelectedAction(selectedJob.enabled ? 'pause' : 'resume')}
                      disabled={Boolean(pendingAction)}
                      title={selectedJob.enabled ? 'Pause cron job' : 'Resume cron job'}
                      onClick={() => runJobAction(selectedJob.enabled ? 'pause' : 'resume', selectedJob)}
                    />
                    <JobActionButton
                      icon={<Play size={14} />}
                      label="Run now"
                      loading={isSelectedAction('run')}
                      disabled={Boolean(pendingAction)}
                      title="Run cron job on the next scheduler tick"
                      onClick={() => runJobAction('run', selectedJob)}
                    />
                    <JobActionButton
                      icon={<Trash2 size={14} />}
                      label="Delete"
                      loading={isSelectedAction('delete')}
                      disabled={Boolean(pendingAction)}
                      title="Delete cron job"
                      variant="danger"
                      onClick={() => setDeleteTarget(selectedJob)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-[260px_minmax(0,1fr)] flex-1 min-h-0">
                  <div className="border-b xl:border-b-0 xl:border-r border-zinc-200 dark:border-zinc-800 min-h-[180px] xl:min-h-0 overflow-y-auto">
                    <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      Runs
                    </div>
                    {loadingRuns && (
                      <div className="flex items-center gap-2 px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400">
                        <Loader2 size={14} className="animate-spin" />
                        Loading runs
                      </div>
                    )}
                    {!loadingRuns && runs.length === 0 && (
                      <div className="px-3 py-8 text-sm text-zinc-400 dark:text-zinc-500 text-center">
                        No output files yet.
                      </div>
                    )}
                    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {runs.map((run) => (
                        <button
                          key={run.id}
                          onClick={() => setSelectedRunId(run.id)}
                          className={`w-full text-left px-3 py-2.5 transition-colors ${
                            selectedRun?.id === run.id
                              ? 'bg-zinc-100 dark:bg-zinc-800'
                              : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">
                              {formatDate(run.ranAt)}
                            </span>
                            <span className={`inline-flex items-center gap-1 text-xs ${statusClass(run.status)}`}>
                              <CronStatusIcon status={run.status} />
                              {run.status}
                            </span>
                          </div>
                          {run.preview && (
                            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500 line-clamp-2">
                              {run.preview}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="min-w-0 overflow-y-auto">
                    {selectedRun ? (
                      <div className="px-5 py-4">
                        <div className="mb-4 flex items-center justify-between gap-3 text-xs text-zinc-400 dark:text-zinc-500">
                          <span className="font-mono truncate">{selectedRun.path}</span>
                          <span className={`inline-flex items-center gap-1 shrink-0 ${statusClass(selectedRun.status)}`}>
                            <CronStatusIcon status={selectedRun.status} />
                            {selectedRun.status}
                          </span>
                        </div>
                        <div className="max-w-none">
                          {loadingContent ? (
                            <div className="flex items-center gap-2 py-4 text-zinc-400 dark:text-zinc-500">
                              <Loader2 size={14} className="animate-spin" />
                              Loading content
                            </div>
                          ) : runContent ? (
                            <MarkdownContent content={runContent} />
                          ) : (
                            <p className="text-zinc-400 dark:text-zinc-500">No content available.</p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
                        Select a run output.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    {deleteTarget && (
      <DeleteConfirmModal
        title="Delete cron job?"
        body={`Delete "${deleteTarget.name}" from Hermes cron storage.`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    )}
    </>
  );
}
